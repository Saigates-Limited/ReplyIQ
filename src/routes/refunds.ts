// "Refunds without return" API (Part 2). Mounted at /api/refunds. Read + status/notes only — never sends anything.
import { Hono } from 'hono'
import { getDb, type Bindings } from '../db'
import { requireManager, type Vars } from '../auth'
import { dailyRefundCheck, reconcileRefunds, pollRefundEmails, backcheckStep, decidePartial, REFUND_MAILBOX } from '../returns/refunds'
import { parseRefundInitiated, validateParsed } from '../returns/refundParser'
import { accessToken, getMessage, header, messageBody, listConnections } from '../gmail'

export const refundsApi = new Hono<{ Bindings: Bindings; Variables: Vars }>()
const colMissing = (e: any) => /column "?(refund_reason|reconcile_result|spc_ref)"? does not exist|invalid input value for enum|violates check constraint "amazon_events_kind_check"/.test(String(e?.message))
const needMigration = (c: any) => c.json({ error: 'Run db/migrations/0017_returns_and_refunds.sql in Supabase first.' }, 503)

export const ALERT_STATUSES = ['alert', 'chasing', 'claim_filed', 'recovered', 'written_off'] as const
export const RESULT_LABEL: Record<string, string> = {
  ok_cancelled_before_dispatch: 'OK — cancelled before dispatch',
  ok_return_received: 'OK — return received',
  ok_partial_refund: 'OK — partial / goodwill refund (Buyer Cancelled), no phone expected back',
  partial_check_return: 'Partial — check return (Customer Return, part refund, phone not received)',
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
         (SELECT r2.id FROM returns r2 WHERE r2.order_id = e.order_id ORDER BY (r2.status IN ('received','inspected','outcome_agreed','closed')) DESC, r2.created_at DESC LIMIT 1) AS order_return_id,
         (SELECT r2.status FROM returns r2 WHERE r2.order_id = e.order_id ORDER BY (r2.status IN ('received','inspected','outcome_agreed','closed')) DESC, r2.created_at DESC LIMIT 1) AS order_return_status,
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

// GET /api/refunds/:id/source — which Gmail message this event was created from, and what the parser read from it.
// Fetches the message live from the mailbox that stored it (falls back to the refund mailbox) so a wrong read can be seen.
refundsApi.get('/:id{[0-9]+}/source', async (c) => {
  const id = Number(c.req.param('id'))
  const sql = getDb(c.env)
  try {
    const [e] = await sql`SELECT e.*, g.email_address AS mailbox_email, g.label AS mailbox_label FROM amazon_events e LEFT JOIN gmail_connection g ON g.id = e.mailbox_id WHERE e.id = ${id} AND e.kind = 'refund_initiated'`
    if (!e) return c.json({ error: 'Refund event not found' }, 404)
    const stored = { gmail_message_id: e.gmail_message_id, gmail_thread_id: e.gmail_thread_id, mailbox: e.mailbox_email ?? null, mailbox_label: e.mailbox_label ?? null, created_at: e.created_at, received_at: e.received_at,
      parsed: { order_id: e.order_id, amount: e.amount, currency: e.currency, reason: e.refund_reason, spc_ref: e.spc_ref, items: e.refund_items }, raw_excerpt: e.raw_excerpt }
    // Try the mailbox the event was stored from first; if unknown (pre-0013 rows), try every connected mailbox until one has the message.
    const conns = await listConnections(sql)
    const order = [...conns].sort((a, b) => Number(b.id === e.mailbox_id) - Number(a.id === e.mailbox_id) || Number(b.email_address.toLowerCase() === REFUND_MAILBOX) - Number(a.email_address.toLowerCase() === REFUND_MAILBOX))
    const tried: { mailbox: string; result: string }[] = []
    for (const mb of order) {
      try {
        const { token } = await accessToken(c.env, sql, mb.id)
        const m = await getMessage(token, e.gmail_message_id)
        const body = messageBody(m)
        const reparsed = parseRefundInitiated(body, header(m, 'Subject'))
        const warnings = validateParsed(reparsed)
        const storedWarnings = validateParsed({ orderId: e.order_id, amount: e.amount == null ? null : Number(e.amount), currency: e.currency, spcRef: e.spc_ref, reason: e.refund_reason, knownReason: true, excerpt: '', items: Array.isArray(e.refund_items) ? e.refund_items : [] })
        return c.json({ stored, found_in: mb.email_address, tried, warnings, stored_warnings: storedWarnings,
          message: { subject: header(m, 'Subject'), from: header(m, 'From'), to: header(m, 'To'), date: header(m, 'Date'), internal_date: new Date(Number(m.internalDate)).toISOString(), labels: m.labelIds ?? [], snippet: m.snippet ?? '', body_excerpt: body.slice(0, 2500), web_link: `https://mail.google.com/mail/u/${encodeURIComponent(mb.email_address)}/#all/${e.gmail_thread_id ?? e.gmail_message_id}` },
          reparsed: { order_id: reparsed.orderId, amount: reparsed.amount, currency: reparsed.currency, reason: reparsed.reason, spc_ref: reparsed.spcRef, items: reparsed.items },
          mismatch: reparsed.orderId !== e.order_id || Number(reparsed.amount ?? 0) !== Number(e.amount ?? 0) || (reparsed.reason ?? null) !== (e.refund_reason ?? null) })
      } catch (err: any) { tried.push({ mailbox: mb.email_address, result: /404|not found/i.test(String(err?.message)) ? 'message not in this mailbox (deleted or never there)' : String(err?.message).slice(0, 120) }) }
    }
    return c.json({ stored, found_in: null, tried, message: null, note: 'The Gmail message id on this event could not be fetched from any connected mailbox — it was deleted from Gmail, or the mailbox it came from is no longer connected. The stored excerpt below is what the parser saw at the time.' })
  } finally { await sql.end() }
})

// POST /api/refunds/reparse (manager) — re-fetch every refund email from Gmail and re-run the parser on the SAME event rows
// (matched by gmail_message_id, so nothing is duplicated). Fixes order/amount/reason/items/SKU/ASIN, recomputes partial,
// resets status→open so the next reconcile re-judges it. Alerts a human has moved (chasing/claim/recovered/written off) keep their status.
refundsApi.post('/reparse', requireManager, async (c) => {
  const sql = getDb(c.env)
  try {
    const conns = await listConnections(sql)
    const refundConn = conns.find((x) => x.email_address.toLowerCase() === REFUND_MAILBOX && x.enabled) ?? null
    const events = await sql`SELECT id, gmail_message_id, mailbox_id, order_id, amount, refund_reason, status, sku, asin, quantity FROM amazon_events WHERE kind = 'refund_initiated' AND gmail_message_id IS NOT NULL ORDER BY id`
    const tokens = new Map<number, string>()
    const tokenFor = async (mbId: number) => { if (!tokens.has(mbId)) tokens.set(mbId, (await accessToken(c.env, sql, mbId)).token); return tokens.get(mbId)! }
    const out = { total: events.length, updated: 0, unchanged: 0, not_found: 0, errors: [] as string[], rejected: [] as { id: number; order_id: string; warnings: string[] }[], changes: [] as any[] }
    for (const e of events) {
      const order = [e.mailbox_id, refundConn?.id, ...conns.map((x) => x.id)].filter((v, i, a): v is number => v != null && a.indexOf(v) === i)
      let m: any = null
      for (const mbId of order) { try { m = await getMessage(await tokenFor(mbId), e.gmail_message_id); break } catch (err: any) { if (!/404|not found/i.test(String(err?.message))) { out.errors.push(`${e.order_id}: ${String(err?.message).slice(0, 100)}`); break } } }
      if (!m) { out.not_found++; continue }
      const r = parseRefundInitiated(messageBody(m), header(m, 'Subject'))
      if (!r.orderId) { out.errors.push(`${e.order_id}: no order id parsed`); continue }
      // Never overwrite a row with a result that fails the sanity checks — report it for a human instead.
      const bad = validateParsed(r)
      if (bad.length) { out.rejected.push({ id: e.id, order_id: r.orderId, warnings: bad }); continue }
      const partial = (await decidePartial(sql, c.env, r.orderId, r.amount, r.items[0]?.sku ?? null, r.items[0]?.asin ?? null, r.items[0]?.quantity ?? 1)).partial
      const before = { order_id: e.order_id, amount: e.amount == null ? null : Number(e.amount), reason: e.refund_reason, sku: e.sku, asin: e.asin }
      const after = { order_id: r.orderId, amount: r.amount, reason: r.reason, sku: r.items[0]?.sku ?? null, asin: r.items[0]?.asin ?? null }
      const changed = JSON.stringify(before) !== JSON.stringify(after)
      const [k] = await sql`SELECT id FROM cases WHERE order_id = ${r.orderId} ORDER BY id LIMIT 1`
      const humanMoved = ['chasing', 'claim_filed', 'recovered', 'written_off'].includes(e.status)
      await sql`UPDATE amazon_events SET order_id = ${r.orderId}, case_id = COALESCE(case_id, ${k?.id ?? null}), amount = ${r.amount}, currency = ${r.currency ?? 'GBP'}, asin = ${after.asin}, sku = ${after.sku},
                  quantity = ${r.items[0]?.quantity ?? null}, product = ${r.items[0]?.name ?? null}, refund_reason = ${r.reason}, spc_ref = ${r.spcRef}, refund_items = ${sql.json(r.items)}, raw_excerpt = ${r.excerpt},
                  is_partial = ${partial}, needs_manager = ${!r.knownReason}, status = ${humanMoved ? e.status : 'open'}, reconcile_result = ${humanMoved ? sql`reconcile_result` : null}, updated_at = now() WHERE id = ${e.id}`
      if (changed) { out.updated++; if (out.changes.length < 60) out.changes.push({ id: e.id, before, after }) } else out.unchanged++
    }
    // Re-judge everything that was reset to open
    const rec = await reconcileRefunds(sql, c.env)
    return c.json({ ...out, reconcile: rec })
  } catch (e: any) { if (colMissing(e)) return needMigration(c); return c.json({ error: e.message }, 502) } finally { await sql.end() }
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
