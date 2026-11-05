// "Refunds without return" API (Part 2). Mounted at /api/refunds. Read + status/notes only — never sends anything.
import { Hono } from 'hono'
import { getDb, type Bindings } from '../db'
import { requireManager, type Vars } from '../auth'
import { dailyRefundCheck, reconcileRefunds, pollRefundEmails, backcheckStep, REFUND_MAILBOX } from '../returns/refunds'

export const refundsApi = new Hono<{ Bindings: Bindings; Variables: Vars }>()
const colMissing = (e: any) => /column "?(refund_reason|reconcile_result|spc_ref)"? does not exist|invalid input value for enum|violates check constraint "amazon_events_kind_check"/.test(String(e?.message))
const needMigration = (c: any) => c.json({ error: 'Run db/migrations/0017_returns_and_refunds.sql in Supabase first.' }, 503)

export const ALERT_STATUSES = ['alert', 'chasing', 'claim_filed', 'recovered', 'written_off'] as const
export const RESULT_LABEL: Record<string, string> = {
  ok_cancelled_before_dispatch: 'OK — cancelled before dispatch',
  ok_return_received: 'OK — return received',
  alert_shipped_not_back: 'Refunded after dispatch — phone not back',
  alert_shipped_unknown: 'Refunded (Buyer Cancelled) — cannot confirm it never shipped',
  alert_not_received: 'Refunded, phone not received',
  alert_review_reason: 'Unusual refund reason — manager review',
}
export const STATUS_LABEL: Record<string, string> = { open: 'Not checked yet', ok: 'OK', alert: 'Open alert', chasing: 'Chasing', claim_filed: 'Claim filed', recovered: 'Recovered', written_off: 'Written off' }

const LIST = `
  SELECT e.id, e.order_id, e.case_id, e.status, e.amount, e.currency, e.refund_reason, e.spc_ref, e.refund_items, e.is_partial, e.needs_manager, e.received_at, e.sku, e.asin, e.product,
         e.reconcile_result, e.reconciled_at, e.alert_notes, e.alert_updated_at, u.name AS alert_updated_by_name, e.return_id,
         c.case_ref, c.tracking_number AS outbound_tracking, r.status AS return_status, r.return_tracking, r.received_at AS return_received_at,
         GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - e.received_at)) / 86400))::int AS days_outstanding
  FROM amazon_events e LEFT JOIN cases c ON c.id = e.case_id LEFT JOIN returns r ON r.id = e.return_id LEFT JOIN users u ON u.id = e.alert_updated_by
  WHERE e.kind = 'refund_initiated'`

// GET /api/refunds?view=alerts|open|ok|all
refundsApi.get('/', async (c) => {
  const view = c.req.query('view') ?? 'alerts'
  const sql = getDb(c.env)
  try {
    const where = view === 'alerts' ? `AND e.status IN ('alert','chasing','claim_filed')` : view === 'ok' ? `AND e.status = 'ok'` : view === 'unchecked' ? `AND e.status = 'open'` : view === 'closed' ? `AND e.status IN ('recovered','written_off')` : ''
    const rows = await sql.unsafe(`${LIST} ${where} ORDER BY (e.status IN ('alert','chasing','claim_filed')) DESC, e.received_at DESC LIMIT 1000`)
    const [last] = await sql`SELECT started_at, finished_at, status, summary FROM sync_runs WHERE trigger = 'refund_check' ORDER BY started_at DESC LIMIT 1`.catch(() => [] as any[])
    const [bc] = await sql`SELECT value FROM app_settings WHERE key = 'refund_backcheck'`.catch(() => [] as any[])
    return c.json({ refunds: rows, now: new Date().toISOString(), result_labels: RESULT_LABEL, status_labels: STATUS_LABEL, last_run: last ?? null, backcheck: bc?.value ?? null, mailbox: REFUND_MAILBOX })
  } catch (e) { if (colMissing(e)) return needMigration(c); throw e } finally { await sql.end() }
})

// PATCH /api/refunds/:id {status?, notes?} — chasing/recovered by anyone; claim_filed/written_off manager only
refundsApi.patch('/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'))
  const b = (await c.req.json().catch(() => ({}))) as { status?: string; notes?: string }
  const user = c.get('user')
  const sql = getDb(c.env)
  try {
    const [e] = await sql`SELECT id, status FROM amazon_events WHERE id = ${id} AND kind = 'refund_initiated'`
    if (!e) return c.json({ error: 'Refund event not found' }, 404)
    const up: Record<string, any> = { alert_updated_by: user.id, alert_updated_at: new Date() }
    if (b.status !== undefined) {
      if (!ALERT_STATUSES.includes(b.status as any)) return c.json({ error: `Status must be one of ${ALERT_STATUSES.join(', ')}` }, 422)
      if (['claim_filed', 'written_off'].includes(b.status) && user.role !== 'manager') return c.json({ error: 'Only a manager can mark a refund as claim filed or written off' }, 403)
      if (e.status === 'ok' || e.status === 'open') return c.json({ error: `This refund is ${STATUS_LABEL[e.status]}; only alerts can be moved` }, 409)
      up.status = b.status
    }
    if (b.notes !== undefined) up.alert_notes = String(b.notes).slice(0, 4000) || null
    await sql`UPDATE amazon_events SET ${sql(up)}, updated_at = now() WHERE id = ${id}`
    const [row] = await sql.unsafe(`${LIST} AND e.id = $1`, [id])
    return c.json({ refund: row })
  } finally { await sql.end() }
})

// POST /api/refunds/check (manager) — run the daily check now (poll 3 days + reconcile + one back-check window)
refundsApi.post('/check', requireManager, async (c) => {
  const sql = getDb(c.env)
  try { return c.json(await dailyRefundCheck(sql, c.env, 'manual')) }
  catch (e: any) { if (colMissing(e)) return needMigration(c); return c.json({ error: e.message }, 502) }
  finally { await sql.end() }
})
// POST /api/refunds/reconcile (manager) — re-run reconciliation only (no Gmail)
refundsApi.post('/reconcile', requireManager, async (c) => {
  const sql = getDb(c.env)
  try { return c.json(await reconcileRefunds(sql, c.env)) } catch (e: any) { if (colMissing(e)) return needMigration(c); return c.json({ error: e.message }, 502) } finally { await sql.end() }
})
// POST /api/refunds/backcheck (manager) — advance the 90-day back-check by one window (throttled, resumable)
refundsApi.post('/backcheck', requireManager, async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { reset?: boolean }
  const sql = getDb(c.env)
  try {
    if (b.reset) await sql`DELETE FROM app_settings WHERE key = 'refund_backcheck'`
    const r = await backcheckStep(sql, c.env)
    return c.json(r ?? { done: true, note: 'Back-check already complete. Send {reset:true} to run it again.' })
  } catch (e: any) { if (colMissing(e)) return needMigration(c); return c.json({ error: e.message }, 502) } finally { await sql.end() }
})
// POST /api/refunds/poll {days} (manager) — fetch refund emails for N days (dry: nothing sent, just ingest)
refundsApi.post('/poll', requireManager, async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { days?: number }
  const sql = getDb(c.env)
  try { return c.json(await pollRefundEmails(sql, c.env, { days: Math.min(Math.max(Number(b.days) || 3, 1), 90), max: 60 })) }
  catch (e: any) { if (colMissing(e)) return needMigration(c); return c.json({ error: e.message }, 502) } finally { await sql.end() }
})
