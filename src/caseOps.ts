// Lists go to Postgres as 'a,b,c' + string_to_array: the live client runs with fetch_types:false (Hyperdrive), so a JS
// array is sent as plain text and ::int[] fails with "malformed array literal".
// Case-level operations shared by the send routes and the inbox: "resolve after sending" and manual merge of duplicates.
import type { Sql } from './db'

let scKnown: boolean | null = null
async function hasStatusChanged(sql: Sql) {
  if (scKnown !== null) return scKnown
  const [r] = await sql`SELECT 1 FROM information_schema.columns WHERE table_name = 'cases' AND column_name = 'status_changed_at'`
  scKnown = !!r
  return scKnown
}

/** Why a case must not be closed yet. Same rules as bulk "Mark resolved", plus other drafts still waiting on a manager.
 *  `exceptDraftId` = the draft being sent right now (it no longer counts as waiting). */
export async function resolveBlockers(sql: Sql, caseId: number, exceptDraftId: number | null = null): Promise<string[]> {
  const [r] = await sql`
    SELECT c.battery_flag,
      EXISTS (SELECT 1 FROM amazon_events e WHERE e.case_id = c.id AND e.kind LIKE 'atoz%' AND e.status NOT IN ('won','lost','closed')) AS open_atoz,
      EXISTS (SELECT 1 FROM amazon_events e WHERE e.case_id = c.id AND e.kind = 'chargeback' AND e.status NOT IN ('won','lost','closed')) AS open_chargeback,
      EXISTS (SELECT 1 FROM drafts d WHERE d.case_id = c.id AND d.id IS DISTINCT FROM ${exceptDraftId}
              AND ((d.status = 'draft' AND d.needs_manager = TRUE) OR d.status = 'pending_approval')) AS manager_draft
    FROM cases c WHERE c.id = ${caseId}`
  if (!r) return ['case not found']
  const why: string[] = []
  if (r.open_atoz) why.push('open A-to-Z claim')
  if (r.open_chargeback) why.push('open chargeback')
  if (r.battery_flag) why.push('battery/heat flag')
  if (r.manager_draft) why.push('another draft is waiting for a manager')
  return why
}

/** Status after a reply has gone out. resolve=true closes the case unless something above blocks it; then it falls
 *  back to the normal "Awaiting customer" and the reasons are returned so the UI can say why it stayed open. */
export async function statusAfterSend(tx: Sql, caseId: number, resolve: boolean, draftId: number): Promise<{ status: 'resolved' | 'awaiting_customer' | 'unchanged'; blocked: string[] }> {
  const blocked = resolve ? await resolveBlockers(tx, caseId, draftId) : []
  const sc = (await hasStatusChanged(tx)) ? tx`, status_changed_at = now()` : tx``
  if (resolve && !blocked.length) {
    await tx`UPDATE cases SET status = 'resolved', updated_at = now() ${sc} WHERE id = ${caseId}`
    return { status: 'resolved', blocked }
  }
  const u = await tx`UPDATE cases SET status = 'awaiting_customer', updated_at = now() ${sc} WHERE id = ${caseId} AND status = 'open' RETURNING id`
  return { status: u.length ? 'awaiting_customer' : 'unchanged', blocked }
}

export type MergeResult =
  | { ok: true; into: { id: number; case_ref: string }; merged: { id: number; case_ref: string }[]; moved: Record<string, number>; duplicates_removed: number; status: string }
  | { ok: false; status: number; error: string }

/** Merge `ids` into `intoId`: every message, draft, attachment, Amazon event, carrier case, return and review request
 *  moves to the kept case; copies of the same email (same Message-ID, or same text within 2 min) are collapsed to one;
 *  the other cases are archived with a note pointing at the kept one. Nothing is deleted except duplicate message rows.
 *  Agents may merge cases of the same customer (same email address or order ID); anything else needs a manager. */
export async function mergeCases(sql: Sql, intoId: number, ids: number[], user: { id: number; name: string; role: string }): Promise<MergeResult> {
  const others = [...new Set(ids.filter((n) => n !== intoId))]
  if (!others.length) return { ok: false, status: 400, error: 'Select at least two cases to merge' }
  if (others.length > 20) return { ok: false, status: 400, error: 'Merge at most 20 cases at a time' }
  const all = [intoId, ...others]
  const rows = await sql`SELECT id, case_ref, order_id, lower(coalesce(customer_email, customer_reply_to, '')) AS who, archived_at, status
                         FROM cases WHERE id = ANY(string_to_array(${all.join(',')}, ',')::int[])`
  if (rows.length !== all.length) return { ok: false, status: 404, error: 'One of the selected cases was not found' }
  const byId = new Map(rows.map((r: any) => [r.id, r]))
  const into: any = byId.get(intoId)
  if (into.archived_at) return { ok: false, status: 409, error: `${into.case_ref} is archived; pick an active case to keep` }
  const orders = [...new Set(rows.map((r: any) => r.order_id).filter(Boolean))]
  if (orders.length > 1) return { ok: false, status: 409, error: `These cases are for different orders (${orders.join(', ')}), so they are not duplicates` }
  const whos = [...new Set(rows.map((r: any) => r.who).filter(Boolean))]
  const sameCustomer = orders.length === 1 || whos.length <= 1
  if (!sameCustomer && user.role !== 'manager') return { ok: false, status: 403, error: 'These cases look like different customers. Only a manager can merge them.' }
  const [busy] = await sql`SELECT 1 FROM drafts WHERE case_id = ANY(string_to_array(${all.join(',')}, ',')::int[]) AND status = 'sending' LIMIT 1`
  if (busy) return { ok: false, status: 409, error: 'A reply on one of these cases is being sent right now. Try again in a moment.' }

  const moved: Record<string, number> = {}
  let duplicatesRemoved = 0
  let finalStatus = into.status
  await sql.begin(async (tx) => {
    const move = async (table: string) => {
      const [t] = await tx`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table} AND column_name = 'case_id'`
      if (!t) return
      const r = await tx.unsafe(`UPDATE public.${table} SET case_id = $1 WHERE case_id = ANY(string_to_array($2, ',')::int[])`, [intoId, others.join(',')])
      moved[table] = r.count
    }
    for (const t of ['messages', 'drafts', 'attachments', 'amazon_events', 'carrier_cases', 'returns', 'review_requests']) await move(t)

    // Collapse copies of the same email that now sit side by side (keep the earliest row).
    const dups = await tx`
      SELECT DISTINCT ON (b.id) b.id AS drop_id, a.id AS keep_id
      FROM messages a JOIN messages b
        ON b.case_id = a.case_id AND b.id > a.id AND b.direction = a.direction AND b.kind = a.kind
       AND ((a.rfc_message_id IS NOT NULL AND a.rfc_message_id = b.rfc_message_id)
         OR (a.body = b.body AND abs(extract(epoch from (a.sent_at - b.sent_at))) < 120))
      WHERE a.case_id = ${intoId}
      ORDER BY b.id, a.id`
    for (const d of dups as any[]) {
      if (dups.some((x: any) => x.drop_id === d.keep_id)) continue // keep_id is itself a later copy; its own keeper handles it
      await tx`UPDATE attachments SET message_id = ${d.keep_id} WHERE message_id = ${d.drop_id}`
      await tx`UPDATE messages k SET rfc_message_id = COALESCE(k.rfc_message_id, x.rfc_message_id), tone = COALESCE(k.tone, x.tone),
                 tone_source = COALESCE(k.tone_source, x.tone_source), tone_model = COALESCE(k.tone_model, x.tone_model)
               FROM messages x WHERE k.id = ${d.keep_id} AND x.id = ${d.drop_id}`
      const del = await tx`DELETE FROM messages WHERE id = ${d.drop_id} RETURNING id`
      duplicatesRemoved += del.length
    }

    // Kept case: take what the others knew, latest customer message, and reopen if the customer spoke last.
    await tx`
      UPDATE cases k SET
        order_id = COALESCE(k.order_id, o.order_id), device_model = COALESCE(k.device_model, o.device_model),
        battery_flag = k.battery_flag OR o.battery_flag, chargeback_open = k.chargeback_open OR o.chargeback_open,
        assigned_to = COALESCE(k.assigned_to, o.assigned_to),
        last_customer_message_at = GREATEST(k.last_customer_message_at, o.last_customer_message_at),
        internal_notes = NULLIF(concat_ws(E'\n', k.internal_notes, o.notes), ''),
        updated_at = now()
      FROM (SELECT max(order_id) AS order_id, max(device_model) AS device_model, bool_or(battery_flag) AS battery_flag,
                   bool_or(chargeback_open) AS chargeback_open, min(assigned_to) AS assigned_to,
                   max(last_customer_message_at) AS last_customer_message_at,
                   string_agg(NULLIF(internal_notes, ''), E'\n' ORDER BY id) AS notes
            FROM cases WHERE id = ANY(string_to_array(${others.join(',')}, ',')::int[])) o
      WHERE k.id = ${intoId}`
    const [last] = await tx`SELECT direction FROM messages WHERE case_id = ${intoId} AND kind IS DISTINCT FROM 'event' ORDER BY sent_at DESC, id DESC LIMIT 1`
    if (last?.direction === 'inbound' && into.status !== 'open') {
      await tx`UPDATE cases SET status = 'open' WHERE id = ${intoId}`
      finalStatus = 'open'
    }
    const refs = others.map((id) => (byId.get(id) as any).case_ref).join(', ')
    await tx`INSERT INTO messages (case_id, direction, sender, body, kind, sent_at)
             VALUES (${intoId}, 'inbound', 'ReplyIQ', ${`Merged ${refs} into ${into.case_ref} (by ${user.name}).`}, 'event', now())`
    await tx`UPDATE cases SET archived_at = now(), archived_by = ${user.id}, status = 'resolved', updated_at = now(),
               internal_notes = concat_ws(E'\n', internal_notes, ${`Merged into ${into.case_ref} on ${new Date().toISOString().slice(0, 10)} by ${user.name}.`}::text)
             WHERE id = ANY(string_to_array(${others.join(',')}, ',')::int[])`
  })
  return { ok: true, into: { id: intoId, case_ref: into.case_ref }, merged: others.map((id) => ({ id, case_ref: (byId.get(id) as any).case_ref })), moved, duplicates_removed: duplicatesRemoved, status: finalStatus }
}
