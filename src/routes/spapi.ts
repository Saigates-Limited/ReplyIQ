// SP-API routes: order details (fills empty case fields) and review requests (Solicitations API only).
import { Hono } from 'hono'
import { getDb, type Bindings } from '../db'
import type { Vars } from '../auth'
import { fetchOrder, reviewRequestEligible, sendReviewRequest, spapiConfigured, testConnection, SpapiError, type SpapiEnv, type OrderSummary } from '../spapi'

export const spapiApi = new Hono<{ Bindings: Bindings; Variables: Vars }>()

const REVIEW_MIN_DAYS = 7 // our rule: 7 days after delivery…
const REVIEW_MAX_DAYS = 30 // …and inside Amazon's 5–30 day window. Same for every order; never tone/outcome based.

// GET /api/spapi/status
spapiApi.get('/status', (c) => c.json({ configured: spapiConfigured(c.env as SpapiEnv), review_rule: { min_days: REVIEW_MIN_DAYS, max_days: REVIEW_MAX_DAYS } }))

// POST /api/spapi/test (manager) — token exchange only
spapiApi.post('/test', async (c) => {
  if (c.get('user').role !== 'manager') return c.json({ error: 'Managers only' }, 403)
  return c.json(await testConnection(c.env as SpapiEnv))
})

/**
 * POST /api/cases/:id/fetch-order { force?: boolean }
 * Fetches the order from Amazon, caches it, and fills EMPTY case fields only:
 *   delivery_date (actual if a package is DELIVERED; else promised-window latest, marked estimated),
 *   tracking_number, carrier, device_model (first item title).
 * A date typed by staff is never overwritten. Returns the Amazon summary + what was filled.
 */
spapiApi.post('/cases/:id/fetch-order', async (c) => {
  const caseId = Number(c.req.param('id'))
  const body = (await c.req.json().catch(() => ({}))) as { force?: boolean }
  const sql = getDb(c.env)
  try {
    const [k] = await sql`SELECT * FROM cases WHERE id = ${caseId}`
    if (!k) return c.json({ error: 'Case not found' }, 404)
    if (!k.order_id) return c.json({ error: 'Case has no order ID' }, 400)
    if (!spapiConfigured(c.env as SpapiEnv)) return c.json({ error: 'SP-API not configured', configured: false }, 503)

    // Cache for 6 hours unless forced (rate limit is 0.5 req/s; staff may open many cases)
    let summary: OrderSummary | null = null
    if (!body.force) {
      const [cached] = await sql`SELECT payload, fetched_at FROM amazon_orders WHERE order_id = ${k.order_id} AND fetched_at > now() - INTERVAL '6 hours'`
      if (cached) summary = cached.payload as OrderSummary
    }
    if (!summary) {
      summary = await fetchOrder(c.env as SpapiEnv, k.order_id)
      await sql`INSERT INTO amazon_orders (order_id, payload, fetched_at) VALUES (${k.order_id}, ${sql.json(summary as any)}, now())
                ON CONFLICT (order_id) DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now()`
    }

    // Fill empties only. delivery_date_source records where the date came from.
    const filled: string[] = []
    const upd: Record<string, unknown> = {}
    if (!k.delivery_date && summary.deliveryDate) { upd.delivery_date = summary.deliveryDate; upd.delivery_date_source = summary.deliveryIsEstimate ? 'amazon_estimated' : 'amazon_actual'; filled.push(`delivery_date (${summary.deliveryIsEstimate ? 'estimated' : 'actual'})`) }
    if (!k.tracking_number && summary.trackingNumber) { upd.tracking_number = summary.trackingNumber; filled.push('tracking_number') }
    if (!k.carrier && summary.carrier) { upd.carrier = summary.carrier; filled.push('carrier') }
    if (!k.device_model && summary.items[0]?.title) { upd.device_model = summary.items[0].title.slice(0, 200); filled.push('device_model') }
    upd.spapi_synced_at = new Date()
    const cols = Object.keys(upd)
    await sql.unsafe(`UPDATE cases SET ${cols.map((col, i) => `${col} = $${i + 2}`).join(', ')} WHERE id = $1`, [caseId, ...cols.map((col) => upd[col])] as any[])
    return c.json({ order: summary, filled })
  } catch (e: any) {
    if (e instanceof SpapiError) return c.json({ error: e.message, code: e.code, status: e.status }, e.status === 404 ? 404 : 502)
    throw e
  } finally {
    await sql.end()
  }
})

// GET /api/cases/:id/review-request — eligibility under OUR rule + Amazon's, and any previous request
spapiApi.get('/cases/:id/review-request', async (c) => {
  const caseId = Number(c.req.param('id'))
  const sql = getDb(c.env)
  try {
    const [k] = await sql`SELECT id, order_id, delivery_date FROM cases WHERE id = ${caseId}`
    if (!k) return c.json({ error: 'Case not found' }, 404)
    const [prev] = k.order_id ? await sql`SELECT r.*, u.name AS requested_by_name FROM review_requests r LEFT JOIN users u ON u.id = r.requested_by WHERE r.order_id = ${k.order_id}`.catch(() => [] as any[]) : [null]
    const [src] = await sql`SELECT delivery_date_source FROM cases WHERE id = ${caseId}`.catch(() => [{ delivery_date_source: null }] as any[])
    ;(k as any).delivery_date_source = src?.delivery_date_source ?? null
    const rule = ourRule(k.delivery_date)
    return c.json({ configured: spapiConfigured(c.env as SpapiEnv), order_id: k.order_id, delivery_date: k.delivery_date, delivery_date_source: k.delivery_date_source, previous: prev ?? null, rule })
  } finally {
    await sql.end()
  }
})

function ourRule(deliveryDate: string | Date | null) {
  if (!deliveryDate) return { state: 'no_delivery_date' as const, available_from: null, expires: null, days_since: null }
  const d = new Date(deliveryDate); const days = Math.floor((Date.now() - d.getTime()) / 86400_000)
  const from = new Date(d.getTime() + REVIEW_MIN_DAYS * 86400_000).toISOString().slice(0, 10)
  const exp = new Date(d.getTime() + REVIEW_MAX_DAYS * 86400_000).toISOString().slice(0, 10)
  const state = days < REVIEW_MIN_DAYS ? 'too_early' : days > REVIEW_MAX_DAYS ? 'expired' : 'window_open'
  return { state, available_from: from, expires: exp, days_since: days }
}

/**
 * POST /api/cases/:id/review-request — manual "Request review".
 * Order of checks: our 7–30 day rule → once per order (DB) → Amazon eligibility → send → log.
 */
spapiApi.post('/cases/:id/review-request', async (c) => {
  const caseId = Number(c.req.param('id'))
  const user = c.get('user')
  const sql = getDb(c.env)
  try {
    const [k] = await sql`SELECT id, order_id, delivery_date, customer_first_name FROM cases WHERE id = ${caseId}`
    if (!k) return c.json({ error: 'Case not found' }, 404)
    if (!k.order_id) return c.json({ error: 'Case has no order ID' }, 400)
    const rule = ourRule(k.delivery_date)
    if (rule.state !== 'window_open') return c.json({ error: rule.state === 'no_delivery_date' ? 'Set the delivery date first' : rule.state === 'too_early' ? `Available from ${rule.available_from} (7 days after delivery)` : `Window closed on ${rule.expires} (30 days after delivery)`, rule }, 409)
    if (!spapiConfigured(c.env as SpapiEnv)) return c.json({ error: 'SP-API not configured' }, 503)
    const [prev] = await sql`SELECT id, requested_at, result FROM review_requests WHERE order_id = ${k.order_id}`
    if (prev) return c.json({ error: `A review request was already ${prev.result === 'sent' ? 'sent' : 'attempted'} for this order on ${new Date(prev.requested_at).toISOString().slice(0, 10)}`, previous: prev }, 409)

    // Reserve the slot first so two clicks can't double-send (UNIQUE order_id)
    const [row] = await sql`INSERT INTO review_requests (order_id, case_id, requested_by, result) VALUES (${k.order_id}, ${caseId}, ${user.id}, 'pending') ON CONFLICT (order_id) DO NOTHING RETURNING id`
    if (!row) return c.json({ error: 'A review request is already in progress for this order' }, 409)

    let result = 'sent', detail = ''
    try {
      const el = await reviewRequestEligible(c.env as SpapiEnv, k.order_id)
      if (!el.eligible) { result = 'ineligible'; detail = `Amazon reports this order is not eligible (actions: ${el.actions.join(', ') || 'none'})` }
      else { await sendReviewRequest(c.env as SpapiEnv, k.order_id) ; detail = 'productReviewAndSellerFeedback solicitation sent via Amazon' }
    } catch (e: any) {
      result = e instanceof SpapiError && e.status === 403 ? 'already_requested' : 'error'
      detail = e.message
    }
    await sql`UPDATE review_requests SET result = ${result}, detail = ${detail}, completed_at = now() WHERE id = ${row.id}`
    await sql`INSERT INTO messages (case_id, direction, sender, body, sent_at, kind)
              VALUES (${caseId}, 'outbound', ${'Amazon review request (' + user.name + ')'}, ${result === 'sent' ? 'Review request sent to the customer via Amazon (Solicitations API).' : `Review request not sent: ${detail}`}, now(), 'event')`
    return c.json({ result, detail }, result === 'sent' ? 200 : 409)
  } finally {
    await sql.end()
  }
})
