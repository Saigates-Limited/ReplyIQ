// Physical returns: database operations. Rules live in rules.ts; this file applies them and keeps the case in step.
// Nothing here is ever passed to OpenAI (see ai.ts: the payload builder never reads returns / return_items).
import type { getDb } from '../db'
import { checkImei } from './imei'
import { evaluateItem, isOverdue, daysSince, canMove, FRP_UNLOCK_DAYS, type ReturnStatus, RETURN_STATUSES, REASONS, CABLES, OUTCOMES, DISPOSITIONS } from './rules'

export type Sql = ReturnType<typeof getDb>

let archiveColKnown: boolean | null = null
/** 0018 adds returns.archived_at; until it is run, lists simply show everything. */
export async function hasReturnArchive(sql: Sql) {
  if (archiveColKnown !== null) return archiveColKnown
  const [r] = await sql`SELECT 1 FROM information_schema.columns WHERE table_name = 'returns' AND column_name = 'archived_at'`.catch(() => [] as any[])
  archiveColKnown = !!r
  return archiveColKnown
}
/** Archive instead of delete (manager). Keeps phones, photos and history; hidden from lists/counts; the DB refuses DELETE (0018). */
export async function archiveReturn(sql: Sql, id: number, userId: number, archive: boolean) {
  if (!(await hasReturnArchive(sql))) throw new Error('Archiving returns needs migration 0018 (db/migrations/0018_returns_archive_guard.sql) to be run in Supabase first.')
  const [r] = await sql`UPDATE returns SET archived_at = ${archive ? new Date() : null}, archived_by = ${archive ? userId : null}, updated_at = now() WHERE id = ${id} RETURNING id`
  return !!r
}
export const tableMissing = (e: any) => /relation "(returns|return_items|return_skus|return_supplier_codes|return_photos|return_import_batches)"/.test(String(e?.message))

// ───────── lookups ─────────
export async function loadSkus(sql: Sql) { return sql<{ sku: string; model: string | null; active: boolean }[]>`SELECT sku, model, active FROM return_skus ORDER BY sku` }
export async function loadSuppliers(sql: Sql) { return sql<{ code: string; label: string | null; active: boolean }[]>`SELECT code, label, active FROM return_supplier_codes ORDER BY code` }

/** Make sure every SKU seen on a return notice / refund email exists in the drop-down list (never removes anything). */
export async function ensureSku(sql: Sql, sku: string | null | undefined, model?: string | null, userId?: number | null) {
  const s = String(sku ?? '').trim().toUpperCase()
  if (!s) return
  await sql`INSERT INTO return_skus (sku, model, created_by) VALUES (${s}, ${model ?? null}, ${userId ?? null}) ON CONFLICT (sku) DO UPDATE SET model = COALESCE(return_skus.model, EXCLUDED.model)`.catch(() => {})
}

// ───────── list / detail ─────────
export const LIST_SQL = `
  SELECT r.*, c.case_ref, c.customer_first_name, c.subject AS case_subject, c.battery_flag, c.tracking_number AS outbound_tracking,
    ru.name AS received_by_name, cu.name AS closed_by_name,
    (SELECT COUNT(*)::int FROM return_items i WHERE i.return_id = r.id) AS item_count,
    (SELECT COUNT(*)::int FROM return_items i WHERE i.return_id = r.id AND i.needs_manager AND i.manager_cleared_at IS NULL) AS manager_items,
    (SELECT COUNT(*)::int FROM return_items i WHERE i.return_id = r.id AND i.outcome IS NULL) AS items_without_outcome,
    (SELECT string_agg(i.imei, ', ' ORDER BY i.item_no) FROM return_items i WHERE i.return_id = r.id AND i.imei IS NOT NULL) AS imeis,
    (SELECT string_agg(DISTINCT i.reason_category, ', ') FROM return_items i WHERE i.return_id = r.id AND i.reason_category IS NOT NULL) AS reasons,
    (SELECT string_agg(DISTINCT i.outcome, ', ') FROM return_items i WHERE i.return_id = r.id AND i.outcome IS NOT NULL) AS outcomes,
    (SELECT MIN(i.lock_deadline_at) FROM return_items i WHERE i.return_id = r.id AND i.frp_lock AND i.lock_deadline_at IS NOT NULL AND i.manager_cleared_at IS NULL) AS lock_deadline_at,
    (SELECT e.id FROM amazon_events e WHERE e.kind = 'refund_initiated' AND e.order_id = r.order_id ORDER BY e.received_at DESC LIMIT 1) AS refund_event_id,
    (SELECT e.status FROM amazon_events e WHERE e.kind = 'refund_initiated' AND e.order_id = r.order_id ORDER BY e.received_at DESC LIMIT 1) AS refund_event_status,
    (SELECT COUNT(*)::int FROM returns r2 WHERE r2.id <> r.id AND (r2.order_id = r.order_id OR r2.id = r.repeat_of OR r2.repeat_of = r.id)) AS repeat_count
  FROM returns r LEFT JOIN cases c ON c.id = r.case_id LEFT JOIN users ru ON ru.id = r.received_by LEFT JOIN users cu ON cu.id = r.closed_by`

export function decorate(r: any, now = new Date()) {
  return { ...r, ...daysSince(r, now), overdue: isOverdue(r, now), is_repeat: !!r.repeat_of || (r.repeat_count ?? 0) > 0,
    lock_overdue: !!r.lock_deadline_at && new Date(r.lock_deadline_at) < now }
}

export async function loadReturn(sql: Sql, id: number) {
  const [r] = await sql.unsafe(`${LIST_SQL} WHERE r.id = $1`, [id])
  if (!r) return null
  const items = await sql.unsafe(`
    SELECT i.*, iu.name AS inspected_by_name, ou.name AS outcome_by_name, mu.name AS manager_cleared_by_name,
      (SELECT json_agg(json_build_object('id', p.id, 'attachment_id', p.attachment_id, 'filename', p.filename, 'mime_type', p.mime_type, 'size_bytes', p.size_bytes) ORDER BY p.id) FROM return_photos p WHERE p.return_item_id = i.id) AS photos,
      (SELECT json_agg(json_build_object('return_id', r2.id, 'order_id', r2.order_id, 'status', r2.status, 'received_at', r2.received_at)) FROM return_items i2 JOIN returns r2 ON r2.id = i2.return_id WHERE i2.imei = i.imei AND i2.id <> i.id AND i.imei IS NOT NULL) AS same_imei_returns
    FROM return_items i LEFT JOIN users iu ON iu.id = i.inspected_by LEFT JOIN users ou ON ou.id = i.outcome_by LEFT JOIN users mu ON mu.id = i.manager_cleared_by
    WHERE i.return_id = $1 ORDER BY i.item_no`, [id])
  const related = await sql`SELECT id, order_id, status, received_at, created_at FROM returns WHERE id <> ${id} AND (order_id = ${r.order_id} OR id = ${r.repeat_of ?? -1} OR repeat_of = ${id}) ORDER BY created_at DESC`
  const refund = await sql`SELECT id, status, amount, currency, refund_reason, received_at, reconcile_result, spc_ref, is_partial FROM amazon_events WHERE kind = 'refund_initiated' AND order_id = ${r.order_id} ORDER BY received_at DESC`.catch(() => [] as any[])
  return { ...decorate(r), items, related, refund_events: refund }
}

// ───────── create ─────────
export type CreateInput = {
  order_id: string; case_id?: number | null; event_id?: number | null; order_date?: string | null; delivery_date?: string | null; marketplace?: string | null
  sku?: string | null; asin?: string | null; quantity?: number | null; amazon_reason?: string | null; customer_comment?: string | null; return_tracking?: string | null; notes?: string | null
  status?: ReturnStatus; received_at?: Date | null; received_by?: number | null; legacy_customer_name?: string | null; import_batch_id?: number | null; import_row?: number | null; review_flags?: any[]
}

/** Create a return + its item rows (quantity). Links repeat returns by order id. Fills order/delivery/case from the case when present. */
export async function createReturn(sql: Sql, input: CreateInput, userId: number | null) {
  const orderId = input.order_id.trim()
  // Pull what the case already knows
  // cases has delivery_date (from SP-API / staff) but no order date column; order_date comes from the import or is typed on the return.
  const [k] = input.case_id ? await sql`SELECT id, delivery_date, device_model, tracking_number FROM cases WHERE id = ${input.case_id}`
                            : await sql`SELECT id, delivery_date, device_model, tracking_number FROM cases WHERE order_id = ${orderId} ORDER BY id LIMIT 1`
  const [prev] = await sql`SELECT id FROM returns WHERE order_id = ${orderId} ORDER BY created_at DESC LIMIT 1`
  const qty = Math.max(1, Math.min(10, Number(input.quantity ?? 1) || 1))
  const status = input.status ?? 'expected'
  const [r] = await sql`
    INSERT INTO returns (case_id, event_id, order_id, order_date, delivery_date, marketplace, sku, asin, quantity, amazon_reason, customer_comment, return_tracking, notes, status,
                         received_at, received_by, repeat_of, repeat_reason, legacy_customer_name, import_batch_id, import_row, review_flags, created_by)
    VALUES (${k?.id ?? null}, ${input.event_id ?? null}, ${orderId}, ${input.order_date ?? null}, ${input.delivery_date ?? (k?.delivery_date ? String(k.delivery_date).slice(0, 10) : null)},
            ${input.marketplace ?? 'Amazon.co.uk'}, ${input.sku ? String(input.sku).toUpperCase() : null}, ${input.asin ?? null}, ${qty}, ${input.amazon_reason ?? null}, ${input.customer_comment ?? null},
            ${input.return_tracking ?? null}, ${input.notes ?? null}, ${status}, ${input.received_at ?? (status !== 'expected' ? new Date() : null)}, ${input.received_by ?? (status !== 'expected' ? userId : null)},
            ${prev?.id ?? null}, ${prev ? 'order' : null}, ${k ? null : (input.legacy_customer_name ?? null)}, ${input.import_batch_id ?? null}, ${input.import_row ?? null}, ${sql.json(input.review_flags ?? [])}, ${userId})
    RETURNING id`
  for (let n = 1; n <= qty; n++) await sql`INSERT INTO return_items (return_id, item_no) VALUES (${r.id}, ${n})`
  if (input.sku) await ensureSku(sql, input.sku, k?.device_model ?? null, userId)
  return r.id as number
}

/** Return notice ingested → an "Expected" return, unless one already exists for this order with no later refund/close. */
export async function expectedFromNotice(sql: Sql, ev: { id: number; case_id: number | null; order_id: string; sku: string | null; asin: string | null; quantity: number | null; return_reason: string | null; customer_comment: string | null; product: string | null }) {
  const [open] = await sql`SELECT id FROM returns WHERE order_id = ${ev.order_id} AND status <> 'closed' ORDER BY created_at DESC LIMIT 1`
  if (open) { await sql`UPDATE returns SET event_id = COALESCE(event_id, ${ev.id}), sku = COALESCE(sku, ${ev.sku}), asin = COALESCE(asin, ${ev.asin}), amazon_reason = COALESCE(amazon_reason, ${ev.return_reason}), customer_comment = COALESCE(customer_comment, ${ev.customer_comment}) WHERE id = ${open.id}`; return open.id as number }
  return createReturn(sql, { order_id: ev.order_id, case_id: ev.case_id, event_id: ev.id, sku: ev.sku, asin: ev.asin, quantity: ev.quantity, amazon_reason: ev.return_reason, customer_comment: ev.customer_comment }, null)
}

// ───────── workflow steps ─────────
export async function receive(sql: Sql, id: number, userId: number, b: { return_tracking?: string | null; imeis?: (string | null)[]; imei_matches?: string[] }) {
  const [r] = await sql`SELECT id, status, order_id FROM returns WHERE id = ${id}`
  if (!r) return { error: 'Return not found', status: 404 as const }
  if (r.status !== 'expected') return { error: `Already ${r.status}`, status: 409 as const }
  const items = await sql`SELECT id, item_no FROM return_items WHERE return_id = ${id} ORDER BY item_no`
  const flags: string[] = []
  for (let i = 0; i < items.length; i++) {
    const raw = b.imeis?.[i]
    if (raw) {
      const c = checkImei(raw)
      if (!c.ok) return { error: `IMEI ${i + 1}: ${c.reason}`, status: 422 as const }
      await sql`UPDATE return_items SET imei = ${c.imei}, imei_matches = ${['yes', 'no', 'unknown'].includes(b.imei_matches?.[i] ?? '') ? b.imei_matches![i] : 'unknown'} WHERE id = ${items[i].id}`
      // Repeat return by IMEI?
      const [same] = await sql`SELECT r2.id FROM return_items i2 JOIN returns r2 ON r2.id = i2.return_id WHERE i2.imei = ${c.imei} AND r2.id <> ${id} ORDER BY r2.created_at DESC LIMIT 1`
      if (same) { await sql`UPDATE returns SET repeat_of = COALESCE(repeat_of, ${same.id}), repeat_reason = COALESCE(repeat_reason, 'imei') WHERE id = ${id}`; flags.push(`IMEI ${c.imei} was returned before (return #${same.id})`) }
    }
  }
  await sql`UPDATE returns SET status = 'received', received_at = now(), received_by = ${userId}, return_tracking = COALESCE(${b.return_tracking ?? null}, return_tracking) WHERE id = ${id}`
  // Keep the Amazon return event + refund check in step
  await sql`UPDATE amazon_events SET status = 'received', updated_at = now() WHERE kind = 'return_request' AND order_id = ${r.order_id} AND status = 'requested'`.catch(() => {})
  // Phone is back → any "refund without return" alert on this order clears NOW (not at the next 07:00 check).
  const cleared = await sql`UPDATE amazon_events SET return_id = COALESCE(return_id, ${id}), status = CASE WHEN status IN ('open','alert','chasing') THEN 'ok' ELSE status END,
                               reconcile_result = CASE WHEN status IN ('open','alert','chasing') THEN 'ok_return_received' ELSE reconcile_result END,
                               reconciled_at = CASE WHEN status IN ('open','alert','chasing') THEN now() ELSE reconciled_at END, updated_at = now()
                             WHERE kind = 'refund_initiated' AND order_id = ${r.order_id} RETURNING (status = 'ok') AS now_ok`.catch(() => [] as any[])
  if (cleared.some((x: any) => x.now_ok)) flags.push('Refund-without-return alert cleared — phone received')
  return { ok: true, flags }
}

const pick = (b: any, keys: string[]) => Object.fromEntries(keys.filter((k) => k in b).map((k) => [k, b[k]]))
const inList = (v: any, list: readonly string[]) => v == null || v === '' ? null : list.includes(String(v)) ? String(v) : undefined

/** Update one phone's inspection / outcome / stock fields. Applies the rules and mirrors flags to the case. */
export async function updateItem(sql: Sql, itemId: number, userId: number, role: string, b: Record<string, any>) {
  const [it] = await sql`SELECT i.*, r.order_id, r.case_id, r.status AS return_status, r.notes AS return_notes FROM return_items i JOIN returns r ON r.id = i.return_id WHERE i.id = ${itemId}`
  if (!it) return { error: 'Item not found', status: 404 as const }
  if (it.return_status === 'closed') return { error: 'Return is closed', status: 409 as const }
  const up: Record<string, any> = {}
  const err: Record<string, string> = {}
  for (const [k, list] of [['reason_category', REASONS], ['cable', CABLES], ['outcome', OUTCOMES], ['stock_disposition', DISPOSITIONS], ['imei_matches', ['yes', 'no', 'unknown']]] as const) {
    if (k in b) { const v = inList(b[k], list); if (v === undefined) err[k] = 'invalid value'; else up[k] = v }
  }
  for (const k of ['imei', 'replacement_imei']) if (k in b) {
    if (!b[k]) up[k] = null
    else { const c = checkImei(b[k]); if (!c.ok) err[k] = c.reason; else up[k] = c.imei }
  }
  if ('frp_lock' in b) up.frp_lock = b.frp_lock == null || b.frp_lock === '' ? null : Boolean(b.frp_lock === true || b.frp_lock === 'true' || b.frp_lock === 'yes')
  if ('battery_health' in b) { const n = b.battery_health === '' || b.battery_health == null ? null : Number(b.battery_health); if (n != null && (!Number.isInteger(n) || n < 0 || n > 100)) err.battery_health = '0–100'; else up.battery_health = n }
  if ('refund_amount' in b) { const n = b.refund_amount === '' || b.refund_amount == null ? null : Number(b.refund_amount); if (n != null && (Number.isNaN(n) || n < 0)) err.refund_amount = 'not a number'; else up.refund_amount = n }
  for (const k of ['fault_found', 'cms_ticket', 'compensation_ref', 'notes']) if (k in b) up[k] = b[k] == null ? null : String(b[k]).slice(0, 4000) || null
  for (const k of ['replacement_sent_on', 'repair_completed_on']) if (k in b) up[k] = b[k] ? String(b[k]).slice(0, 10) : null
  if ('supplier_code' in b) {
    if (!b.supplier_code) up.supplier_code = null
    else { const [s] = await sql`SELECT code FROM return_supplier_codes WHERE code = ${String(b.supplier_code).toUpperCase()}`; if (!s) err.supplier_code = 'not in the supplier list'; else up.supplier_code = s.code }
  }
  if (Object.keys(err).length) return { error: 'Validation failed', fields: err, status: 422 as const }
  if (!Object.keys(up).length) return { error: 'Nothing to update', status: 400 as const }

  const merged = { ...it, ...up }
  const rule = evaluateItem(merged, it.return_notes)
  // Inspection / outcome stamps
  if (['reason_category', 'cable', 'frp_lock', 'battery_health', 'fault_found', 'supplier_code'].some((k) => k in up)) { up.inspected_at = new Date(); up.inspected_by = userId }
  if (['outcome', 'refund_amount', 'replacement_imei', 'replacement_sent_on', 'repair_completed_on'].some((k) => k in up)) { up.outcome_at = new Date(); up.outcome_by = userId }
  // FRP lock → start the 2-day unlock clock (once)
  if (rule.startActivationLock && !it.lock_deadline_at) up.lock_deadline_at = new Date(Date.now() + FRP_UNLOCK_DAYS * 86400000)
  if (up.frp_lock === false) up.lock_deadline_at = null
  // Manager flag: set when a rule says so; a manager clearing it is a separate action
  if (rule.needsManager) { up.needs_manager = true; up.manager_reason = rule.managerReasons.join('; ') }
  else if (it.needs_manager && !it.manager_cleared_at && ['cable', 'reason_category', 'outcome', 'refund_amount'].some((k) => k in up)) { up.needs_manager = false; up.manager_reason = null }
  // Manager-only: approving a partial refund over the threshold happens by a manager saving it
  if (rule.needsManager && role === 'manager' && ('outcome' in up || 'refund_amount' in up) && merged.outcome === 'partial_refund') { up.manager_cleared_by = userId; up.manager_cleared_at = new Date() }

  await sql`UPDATE return_items SET ${sql(up)} WHERE id = ${itemId}`
  // Mirror to the case
  if (rule.batteryFlag && it.case_id) await sql`UPDATE cases SET battery_flag = TRUE, updated_at = now() WHERE id = ${it.case_id}`.catch(() => {})
  if (rule.startActivationLock && it.case_id) await sql`UPDATE cases SET status = CASE WHEN status IN ('open','awaiting_customer') THEN 'update_customer' ELSE status END, status_changed_at = CASE WHEN status IN ('open','awaiting_customer') THEN now() ELSE status_changed_at END, updated_at = now() WHERE id = ${it.case_id}`.catch(() => sql`UPDATE cases SET status = CASE WHEN status IN ('open','awaiting_customer') THEN 'update_customer' ELSE status END, updated_at = now() WHERE id = ${it.case_id}`.catch(() => {}))
  // Return status moves forward automatically with the data
  const [agg] = await sql`SELECT COUNT(*) FILTER (WHERE reason_category IS NOT NULL)::int AS inspected, COUNT(*) FILTER (WHERE outcome IS NOT NULL)::int AS decided, COUNT(*)::int AS n FROM return_items WHERE return_id = ${it.return_id}`
  const [ret] = await sql`SELECT status FROM returns WHERE id = ${it.return_id}`
  if (ret.status === 'received' && agg.inspected > 0) await sql`UPDATE returns SET status = 'inspected' WHERE id = ${it.return_id}`
  if (['received', 'inspected'].includes(ret.status) && agg.decided === agg.n) {
    await sql`UPDATE returns SET status = 'outcome_agreed' WHERE id = ${it.return_id}`
    await sql`UPDATE amazon_events SET status = 'inspected', updated_at = now() WHERE kind = 'return_request' AND order_id = ${it.order_id} AND status IN ('requested','received')`.catch(() => {})
  }
  return { ok: true, rule }
}

export async function setStatus(sql: Sql, id: number, userId: number, to: string) {
  if (!RETURN_STATUSES.includes(to as ReturnStatus)) return { error: 'Unknown status', status: 400 as const }
  const [r] = await sql`SELECT status, order_id FROM returns WHERE id = ${id}`
  if (!r) return { error: 'Return not found', status: 404 as const }
  if (r.status === to) return { ok: true }
  if (!canMove(r.status, to as ReturnStatus)) return { error: `Cannot go from ${r.status} to ${to}`, status: 409 as const }
  if (to === 'closed') {
    const [agg] = await sql`SELECT COUNT(*) FILTER (WHERE outcome IS NULL)::int AS undecided, COUNT(*) FILTER (WHERE needs_manager AND manager_cleared_at IS NULL)::int AS pending_manager FROM return_items WHERE return_id = ${id}`
    if (agg.undecided) return { error: `${agg.undecided} phone(s) have no outcome yet`, status: 422 as const }
    if (agg.pending_manager) return { error: `${agg.pending_manager} phone(s) still need a manager's decision`, status: 422 as const }
    await sql`UPDATE returns SET status = 'closed', closed_at = now(), closed_by = ${userId} WHERE id = ${id}`
    const [o] = await sql`SELECT bool_or(outcome IN ('refund','partial_refund')) AS refunded FROM return_items WHERE return_id = ${id}`
    await sql`UPDATE amazon_events SET status = ${o?.refunded ? 'refunded' : 'closed'}, updated_at = now() WHERE kind = 'return_request' AND order_id = ${r.order_id} AND status NOT IN ('refunded','closed')`.catch(() => {})
    return { ok: true }
  }
  await sql`UPDATE returns SET status = ${to}, closed_at = NULL, closed_by = NULL WHERE id = ${id}`
  return { ok: true }
}

export async function clearManager(sql: Sql, itemId: number, userId: number) {
  await sql`UPDATE return_items SET manager_cleared_by = ${userId}, manager_cleared_at = now() WHERE id = ${itemId} AND needs_manager`
}

// ───────── reports ─────────
export async function reports(sql: Sql, from: string | null, to: string | null) {
  const range = sql`WHERE COALESCE(r.received_at, r.created_at) >= ${from ?? '2000-01-01'}::date AND COALESCE(r.received_at, r.created_at) < (${to ?? '2100-01-01'}::date + 1)`
  const bySupplier = await sql`SELECT i.supplier_code, COUNT(*)::int AS returns, COUNT(*) FILTER (WHERE i.reason_category = 'faulty')::int AS faulty FROM return_items i JOIN returns r ON r.id = i.return_id ${range} GROUP BY i.supplier_code ORDER BY returns DESC`
  const byModel = await sql`SELECT COALESCE(s.model, r.sku) AS model, r.sku, COUNT(*)::int AS returns FROM returns r LEFT JOIN return_skus s ON s.sku = r.sku ${range} GROUP BY 1, 2 ORDER BY returns DESC LIMIT 40`
  const byReason = await sql`SELECT i.reason_category, COUNT(*)::int AS n FROM return_items i JOIN returns r ON r.id = i.return_id ${range} GROUP BY 1 ORDER BY n DESC`
  const byOutcome = await sql`SELECT i.outcome, COUNT(*)::int AS n, COALESCE(SUM(i.refund_amount), 0)::float8 AS refunded FROM return_items i JOIN returns r ON r.id = i.return_id ${range} GROUP BY 1 ORDER BY n DESC`
  const [cable] = await sql`SELECT COUNT(*) FILTER (WHERE i.cable = 'not_returned')::int AS missing, COUNT(*) FILTER (WHERE i.cable = 'damaged')::int AS damaged, COUNT(*)::int AS total FROM return_items i JOIN returns r ON r.id = i.return_id ${range}`
  const [repeat] = await sql`SELECT COUNT(*)::int AS n FROM returns r ${range} AND r.repeat_of IS NOT NULL`
  const [totals] = await sql`SELECT COUNT(*)::int AS returns, COUNT(*) FILTER (WHERE r.status = 'closed')::int AS closed, COUNT(*) FILTER (WHERE r.status IN ('received','inspected') AND r.received_at < now() - interval '2 days')::int AS stale FROM returns r ${range}`
  return { by_supplier: bySupplier, by_model: byModel, by_reason: byReason, by_outcome: byOutcome, cable, repeat_returns: repeat.n, totals }
}

/** CSV export (date range on received/created). No customer names unless legacy rows. */
export async function exportCsv(sql: Sql, from: string | null, to: string | null, includeNames = false) {
  const rows = await sql`
    SELECT r.id, r.order_id, r.order_date, r.delivery_date, r.marketplace, r.sku, r.asin, r.quantity, r.amazon_reason, r.status, r.return_tracking, r.received_at, r.closed_at, r.notes AS return_notes, c.case_ref, ${includeNames ? sql`r.legacy_customer_name,` : sql``}
           i.item_no, i.imei, i.imei_matches, i.reason_category, i.cable, i.frp_lock, i.battery_health, i.fault_found, i.supplier_code, i.outcome, i.refund_amount, i.replacement_imei, i.replacement_sent_on, i.repair_completed_on, i.cms_ticket, i.compensation_ref, i.stock_disposition, i.notes AS item_notes
    FROM returns r LEFT JOIN cases c ON c.id = r.case_id LEFT JOIN return_items i ON i.return_id = r.id
    WHERE COALESCE(r.received_at, r.created_at) >= ${from ?? '2000-01-01'}::date AND COALESCE(r.received_at, r.created_at) < (${to ?? '2100-01-01'}::date + 1)
    ORDER BY COALESCE(r.received_at, r.created_at) DESC, r.id, i.item_no`
  const cols = Object.keys(rows[0] ?? { id: 1 })
  const DATE_COLS = new Set(['order_date', 'delivery_date', 'replacement_sent_on', 'repair_completed_on'])
  const esc = (v: any, col?: string) => { let s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v); if (col && DATE_COLS.has(col) && s) s = s.slice(0, 10); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  // IMEIs are prefixed with an apostrophe so Excel/Sheets keep them as text (never a float)
  return [cols.join(','), ...rows.map((r: any) => cols.map((c) => esc(c === 'imei' || c === 'replacement_imei' ? (r[c] ? `'${r[c]}` : '') : r[c], c)).join(','))].join('\n')
}
