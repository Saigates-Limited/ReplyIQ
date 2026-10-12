import { Hono } from 'hono'
import { getDb, type Bindings } from '../db'
import type { Vars } from '../auth'
import { generateDraft, serverChecks, MODEL, DRAFT_MODES, type CaseRow, type MessageRow, type EventRow, type DraftMode } from '../ai'

export const draftsApi = new Hono<{ Bindings: Bindings; Variables: Vars }>()

const DRAFT_SELECT = `
  d.*, 
  cu.name AS created_by_name, eu.name AS edited_by_name, au.name AS approved_by_name, su.name AS sent_recorded_by_name
`
const DRAFT_JOINS = `
  LEFT JOIN users cu ON cu.id = d.created_by
  LEFT JOIN users eu ON eu.id = d.edited_by
  LEFT JOIN users au ON au.id = d.approved_by
  LEFT JOIN users su ON su.id = d.sent_recorded_by
`

async function loadDraft(sql: ReturnType<typeof getDb>, id: number) {
  const [d] = await sql.unsafe(`SELECT ${DRAFT_SELECT} FROM drafts d ${DRAFT_JOINS} WHERE d.id = $1`, [id])
  return d
}

// POST /api/cases/:id/drafts  → generate a new draft with OpenAI (server-side only)
draftsApi.post('/cases/:id/drafts', async (c) => {
  const caseId = Number(c.req.param('id'))
  if (!Number.isInteger(caseId)) return c.json({ error: 'Invalid id' }, 400)
  const user = c.get('user')
  const body = (await c.req.json().catch(() => ({}))) as { mode?: string }
  const mode: DraftMode = DRAFT_MODES.includes(body.mode as DraftMode) ? (body.mode as DraftMode) : 'customer'
  const sql = getDb(c.env)
  try {
    const [kase] = await sql<CaseRow[]>`SELECT * FROM cases WHERE id = ${caseId}`
    if (!kase) return c.json({ error: 'Case not found' }, 404)
    const messages = await sql<MessageRow[]>`SELECT direction, body, sent_at, sender, kind, id FROM messages WHERE case_id = ${caseId} ORDER BY sent_at ASC`
    // Attachment METADATA only (filename/type/size) so the model knows photos exist; bytes never leave Gmail/R2.
    const atts = await sql<{ message_id: number; filename: string; mime_type: string; size_bytes: number }[]>`SELECT message_id, filename, mime_type, size_bytes FROM attachments WHERE case_id = ${caseId}`.catch(() => [] as any[])
    for (const m of messages as any[]) m.attachments = atts.filter((a) => a.message_id === m.id)
    const events = await sql<EventRow[]>`
      SELECT kind, status, amount, currency, received_at, deadline_at, return_reason, customer_comment, authorisation, policy_check, item_description
      FROM amazon_events WHERE case_id = ${caseId} ORDER BY received_at ASC`
    if (!messages.length && !events.length) return c.json({ error: 'Case has no messages to reply to' }, 400)
    if (mode === 'customer' && !messages.some((m) => m.direction === 'inbound' && m.kind !== 'event'))
      return c.json({ error: 'No customer message on this case to reply to. Use a Seller Central mode instead.' }, 400)

    const { result, payload } = await generateDraft(c.env, kase, messages, { events, mode })
    const findings = serverChecks(result.draft, kase, mode)
    const checkResult = findings.some((f) => f.severity === 'fail') ? 'FAIL' : 'PASS'

    // needs_manager: the model's flag OR any Step-0 / rule trigger we can verify from the data.
    const threadText = messages.filter((m) => m.direction === 'inbound').map((m) => m.body).join('\n').toLowerCase()
    const legal = /\b(consumer rights act|trading standards|legal action|solicitor|chargeback|a[- ]to[- ]z|a-z claim|section 75|small claims|ombudsman)\b/.test(threadText)
    const batterySafety = /\b(swollen|swelling|bulging|burning|smoke|smoking|very hot|too hot|overheat)/.test(threadText) && /\b(battery|charg|hot|burn|smoke|swell|bulg)/.test(threadText)
    const reasons: string[] = []
    if (kase.refund_issued === true) reasons.push('refund already issued')
    if (kase.a_to_z_open === true) reasons.push('A-to-Z claim open')
    if (kase.chargeback_open === true) reasons.push('chargeback open')
    if (legal) reasons.push('customer mentions legal/A-to-Z/chargeback')
    if (batterySafety) reasons.push('swollen/hot/burning battery')
    if (kase.battery_flag === true) reasons.push('battery/heat flag on order')
    if (findings.some((f) => f.rule === 'refund_over_15')) reasons.push('refund above £15')
    if (mode !== 'customer') reasons.push('statement to Amazon / Seller Central')
    if (result.needs_manager && !reasons.length) reasons.push('flagged by model')
    const needsManager = result.needs_manager || reasons.length > 0
    const urgency = batterySafety || kase.battery_flag === true ? 'high' : result.urgency

    const [d] = await sql`
      INSERT INTO drafts (case_id, tree, draft_text, original_text, staff_notes, check_result, check_findings, server_findings,
                          needs_manager, needs_manager_reason, urgency, model, created_by, mode)
      VALUES (${caseId}, ${result.lane}, ${result.draft}, ${result.draft}, ${result.staff_notes}, ${checkResult},
              ${sql.json([])}, ${sql.json(findings)},
              ${needsManager}, ${reasons.join('; ')}, ${urgency}, ${MODEL}, ${user.id}, ${mode})
      RETURNING id`
    const draft = await loadDraft(sql, d.id)
    // Return what was sent to the model so the agent can see exactly what left the server.
    return c.json({ draft, sent_to_model: payload }, 201)
  } finally {
    await sql.end()
  }
})

// PATCH /api/drafts/:id  → edit text / staff notes (re-runs server checks)
draftsApi.patch('/drafts/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = (await c.req.json().catch(() => ({}))) as { draft_text?: string; staff_notes?: string }
  const user = c.get('user')
  const sql = getDb(c.env)
  try {
    const existing = await loadDraft(sql, id)
    if (!existing) return c.json({ error: 'Draft not found' }, 404)
    if (existing.status === 'sent') return c.json({ error: 'Draft already recorded as sent' }, 409)

    const text = typeof body.draft_text === 'string' ? body.draft_text.trim() : existing.draft_text
    if (!text) return c.json({ error: 'Draft text cannot be empty' }, 400)
    const notes = typeof body.staff_notes === 'string' ? body.staff_notes : existing.staff_notes
    const [kase] = await sql<CaseRow[]>`SELECT * FROM cases WHERE id = ${existing.case_id}`
    const findings = serverChecks(text, kase, (existing.mode as DraftMode) || 'customer')
    const serverFail = findings.some((f) => f.severity === 'fail')
    // Editing an approved draft un-approves it — approval must be re-given on the final text.
    await sql`
      UPDATE drafts SET draft_text = ${text}, staff_notes = ${notes}, server_findings = ${sql.json(findings)},
        check_result = ${serverFail ? 'FAIL' : 'PASS'},
        status = CASE WHEN status = 'approved' THEN 'draft' ELSE status END,
        approved_by = CASE WHEN status = 'approved' THEN NULL ELSE approved_by END,
        approved_at = CASE WHEN status = 'approved' THEN NULL ELSE approved_at END,
        edited_by = ${user.id}, edited_at = now(), updated_at = now()
      WHERE id = ${id}`
    return c.json({ draft: await loadDraft(sql, id) })
  } finally {
    await sql.end()
  }
})

// POST /api/drafts/:id/approve
draftsApi.post('/drafts/:id/approve', async (c) => {
  const id = Number(c.req.param('id'))
  const user = c.get('user')
  const sql = getDb(c.env)
  try {
    const d = await loadDraft(sql, id)
    if (!d) return c.json({ error: 'Draft not found' }, 404)
    if (d.status !== 'draft') return c.json({ error: `Draft is already ${d.status}` }, 409)
    if (d.needs_manager && user.role !== 'manager')
      return c.json({ error: 'This draft needs a manager. Only a manager can approve it.' }, 403)
    const serverFail = (d.server_findings ?? []).some((f: any) => f.severity === 'fail')
    if (serverFail) return c.json({ error: 'Fix the failing checks before approving' }, 422)
    await sql`UPDATE drafts SET status = 'approved', approved_by = ${user.id}, approved_at = now(), updated_at = now() WHERE id = ${id}`
    return c.json({ draft: await loadDraft(sql, id) })
  } finally {
    await sql.end()
  }
})

// POST /api/drafts/:id/unapprove  (manager, or the approver)
draftsApi.post('/drafts/:id/unapprove', async (c) => {
  const id = Number(c.req.param('id'))
  const user = c.get('user')
  const sql = getDb(c.env)
  try {
    const d = await loadDraft(sql, id)
    if (!d) return c.json({ error: 'Draft not found' }, 404)
    if (d.status !== 'approved') return c.json({ error: 'Draft is not approved' }, 409)
    if (user.role !== 'manager' && d.approved_by !== user.id) return c.json({ error: 'Only the approver or a manager can withdraw approval' }, 403)
    await sql`UPDATE drafts SET status = 'draft', approved_by = NULL, approved_at = NULL, updated_at = now() WHERE id = ${id}`
    return c.json({ draft: await loadDraft(sql, id) })
  } finally {
    await sql.end()
  }
})

// POST /api/drafts/:id/record-sent → agent confirms they sent the approved text manually via Amazon.
// This app never sends anything itself; this only logs the outbound message on the thread.
draftsApi.post('/drafts/:id/record-sent', async (c) => {
  const id = Number(c.req.param('id'))
  const user = c.get('user')
  const sql = getDb(c.env)
  try {
    const d = await loadDraft(sql, id)
    if (!d) return c.json({ error: 'Draft not found' }, 404)
    if (d.status !== 'approved') return c.json({ error: 'Only approved drafts can be recorded as sent' }, 409)
    const toAmazon = d.mode && d.mode !== 'customer'
    await sql.begin(async (tx) => {
      await tx`UPDATE drafts SET status = 'sent', sent_recorded_by = ${user.id}, sent_recorded_at = now(), updated_at = now() WHERE id = ${id}`
      await tx`INSERT INTO messages (case_id, direction, sender, body, kind) VALUES (${d.case_id}, 'outbound', ${(toAmazon ? 'Saigates → Amazon/Seller Central (' : 'Saigates Support (') + user.name + ')'}, ${d.draft_text}, ${toAmazon ? 'seller_central_copy' : 'message'})`
      if (toAmazon) {
        // Mark the matching open Amazon event as responded
        const evKind = d.mode === 'seller_central_atoz' ? ['atoz_claim', 'atoz_info_request'] : d.mode === 'chargeback_evidence' ? ['chargeback'] : ['return_request']
        await tx`UPDATE amazon_events SET status = CASE WHEN kind = 'return_request' THEN status ELSE 'response_sent' END,
                   response_text = ${d.draft_text}, responded_by = ${user.id}, responded_at = now(), updated_at = now()
                 WHERE case_id = ${d.case_id} AND kind = ANY(string_to_array(${evKind.join(',')}, ',')) AND status IN ('open','requested','info_requested')`
      }
      await tx`UPDATE cases SET status = 'awaiting_customer', updated_at = now() WHERE id = ${d.case_id} AND status = 'open'`
    })
    return c.json({ draft: await loadDraft(sql, id) })
  } finally {
    await sql.end()
  }
})

// POST /api/drafts/:id/discard
draftsApi.post('/drafts/:id/discard', async (c) => {
  const id = Number(c.req.param('id'))
  const sql = getDb(c.env)
  try {
    const d = await loadDraft(sql, id)
    if (!d) return c.json({ error: 'Draft not found' }, 404)
    if (d.status === 'sent') return c.json({ error: 'Cannot discard a sent draft' }, 409)
    await sql`UPDATE drafts SET status = 'discarded', updated_at = now() WHERE id = ${id}`
    return c.json({ draft: await loadDraft(sql, id) })
  } finally {
    await sql.end()
  }
})
