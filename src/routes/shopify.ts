// Shopify (Saisales.co.uk) routes: connection status, the order on a case, refunds and returns.
// Every action on Shopify is taken by a logged-in member of staff pressing a button after a confirmation screen;
// nothing here runs on a schedule. Each action is written to shopify_actions (who, what, amount, result).
import { Hono } from 'hono'
import { getDb, type Bindings, type Sql } from '../db'
import { requireManager, type Vars } from '../auth'
import {
  shopifyConfigured, shopDomain, shopifyGql, getOrder, findOrderByName, findOrdersByEmail, orderRefsInText, attachOrderToCase, orderFacts,
  planRefund, refundAllowed, createRefund, returnableLines, openReturn, cancelReturn, attachReturnLabel, processReturn, returnOn, addressLines,
  AGENT_REFUND_LIMIT, SHOPIFY_SCOPES, ShopifyError,
} from '../shopify'
import { getSaisalesSettings, saveSaisalesSettings } from '../saisales'
import { listConnections } from '../gmail'

export const shopifyApi = new Hono<{ Bindings: Bindings; Variables: Vars }>()

const fail = (c: any, e: any) => {
  const status = e instanceof ShopifyError ? e.status : /relation "shopify_actions"|column "(channel|shopify_order)/.test(String(e?.message)) ? 503 : 500
  const msg = status === 503 && !(e instanceof ShopifyError) ? 'Run db/migrations/0029_shopify.sql first' : String(e?.message ?? e)
  return c.json({ error: msg }, status)
}

async function migrated(sql: Sql) {
  const [r] = await sql`SELECT 1 FROM information_schema.tables WHERE table_name = 'shopify_actions'`
  return !!r
}

// GET /api/shopify/status → is Shopify connected, which mailboxes read Saisales mail, Saisales send-from settings
shopifyApi.get('/status', async (c) => {
  const sql = getDb(c.env)
  try {
    const configured = shopifyConfigured(c.env)
    let shop: string | null = null
    try { shop = configured ? shopDomain(c.env) : null } catch { /* reported by /test */ }
    const mig = await migrated(sql)
    const boxes = (await listConnections(sql)).map((m) => ({ id: m.id, label: m.label, email: m.email_address, enabled: m.enabled, saisales_mail: !!m.saisales_mail }))
    const [counts] = mig ? await sql`SELECT COUNT(*) FILTER (WHERE channel = 'shopify')::int AS cases, COUNT(*) FILTER (WHERE channel = 'shopify' AND status <> 'resolved' AND archived_at IS NULL)::int AS open FROM cases` : [{ cases: 0, open: 0 }]
    return c.json({ configured, shop, migration_applied: mig, scopes: SHOPIFY_SCOPES, agent_refund_limit: AGENT_REFUND_LIMIT, settings: await getSaisalesSettings(sql), mailboxes: boxes, cases: counts })
  } catch (e) { return fail(c, e) } finally { await sql.end() }
})

// POST /api/shopify/test (manager) → get a token and read the shop name
shopifyApi.post('/test', requireManager, async (c) => {
  const sql = getDb(c.env)
  try {
    const d = await shopifyGql(c.env, sql, `{ shop { name myshopifyDomain currencyCode } orders(first: 1, sortKey: CREATED_AT, reverse: true) { nodes { name createdAt } } }`)
    return c.json({ ok: true, detail: `Connected to ${d.shop.name} (${d.shop.myshopifyDomain}), ${d.shop.currencyCode}. Latest order ${d.orders?.nodes?.[0]?.name ?? 'none'}.` })
  } catch (e: any) { return c.json({ ok: false, detail: String(e?.message ?? e) }) } finally { await sql.end() }
})

// PATCH /api/shopify/settings (manager) {addresses?, from_address?, from_name?}
shopifyApi.patch('/settings', requireManager, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as any
  const sql = getDb(c.env)
  try { return c.json({ ok: true, settings: await saveSaisalesSettings(sql, body, c.get('user').id) }) }
  catch (e: any) { return c.json({ error: e.message }, 400) } finally { await sql.end() }
})

// ───────── The order on a case ─────────
async function loadCase(sql: Sql, id: number) {
  const [k] = await sql`SELECT id, case_ref, channel, order_id, customer_email, customer_reply_to, customer_first_name, shopify_order_gid, refund_issued FROM cases WHERE id = ${id}`
  return k ?? null
}

/** Staff view of the order: facts + what staff need to act (addresses, returnable lines, refundable amount). */
async function staffView(c: any, sql: Sql, o: any) {
  let maxRefundable: number | null = null
  try {
    const p = await planRefund(c.env, sql, o.id, 0.01)
    maxRefundable = 'error' in p ? 0 : p.maxRefundable
  } catch { /* shown as unknown */ }
  return {
    gid: o.id,
    admin_url: `https://admin.shopify.com/store/${shopDomain(c.env).replace('.myshopify.com', '')}/orders/${String(o.id).split('/').pop()}`,
    facts: orderFacts(o),
    customer: { name: [o.customer?.firstName, o.customer?.lastName].filter(Boolean).join(' ') || o.shippingAddress?.name || null, email: o.email ?? null },
    shipping_address: addressLines(o.shippingAddress),
    billing_address: addressLines(o.billingAddress),
    max_refundable: maxRefundable,
    manual_payment: (o.transactions ?? []).some((t: any) => t.manualPaymentGateway && ['SALE', 'CAPTURE'].includes(t.kind)),
    returnable: returnableLines(o),
    returns: (o.returns?.nodes ?? []).map((r: any) => ({ id: r.id, name: r.name, status: r.status, created: r.createdAt, closed: r.closedAt, rfo: r.reverseFulfillmentOrders?.nodes?.[0]?.id ?? null,
      label: (r.reverseFulfillmentOrders?.nodes ?? []).flatMap((x: any) => x.reverseDeliveries?.nodes ?? []).map((d: any) => d.deliverable).find((d: any) => d?.label || d?.tracking) ?? null,
      items: (r.returnLineItems?.nodes ?? []).map((li: any) => ({ title: li.fulfillmentLineItem?.lineItem?.title ?? 'Item', quantity: li.quantity })) })),
  }
}

// GET /api/shopify/cases/:id → refresh the case's Shopify order (or try to find it) and return the staff view
shopifyApi.get('/cases/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const sql = getDb(c.env)
  try {
    if (!shopifyConfigured(c.env)) return c.json({ configured: false, error: 'Shopify is not connected yet. A manager sets it up under Settings → Shopify.' }, 503)
    const k = await loadCase(sql, id)
    if (!k) return c.json({ error: 'Case not found' }, 404)
    if (k.channel !== 'shopify') return c.json({ configured: true, order: null, not_saisales: true })
    let o = k.shopify_order_gid ? await getOrder(c.env, sql, k.shopify_order_gid) : null
    let how = o ? 'linked' : null
    if (!o && k.order_id) { o = await findOrderByName(c.env, sql, k.order_id); if (o) how = 'order number on the case' }
    if (!o) {
      const [m] = await sql`SELECT string_agg(body, ' ') AS t FROM messages WHERE case_id = ${id} AND direction = 'inbound' AND kind IS DISTINCT FROM 'event'`
      for (const r of orderRefsInText(String(m?.t ?? ''))) { o = await findOrderByName(c.env, sql, r); if (o) { how = `order number ${r} in the customer's message`; break } }
    }
    const email = k.customer_email || k.customer_reply_to
    if (!o && email && !/@marketplace\.amazon\./i.test(email)) { o = (await findOrdersByEmail(c.env, sql, email, 1))[0] ?? null; if (o) how = "customer's latest order (same email)" }
    const others = email && !/@marketplace\.amazon\./i.test(email) ? (await findOrdersByEmail(c.env, sql, email, 5)).map((x: any) => ({ gid: x.id, name: x.name, placed: String(x.processedAt ?? x.createdAt).slice(0, 10), total: x.currentTotalPriceSet?.shopMoney?.amount })) : []
    if (!o) return c.json({ configured: true, order: null, other_orders: others })
    await attachOrderToCase(sql, id, o)
    const actions = await sql`SELECT a.id, a.kind, a.status, a.amount, a.reason, a.error, a.created_at, u.name AS by FROM shopify_actions a LEFT JOIN users u ON u.id = a.created_by WHERE a.case_id = ${id} ORDER BY a.created_at DESC LIMIT 20`.catch(() => [])
    return c.json({ configured: true, matched_by: how, order: await staffView(c, sql, o), other_orders: others.filter((x: any) => x.gid !== o.id), actions })
  } catch (e) { return fail(c, e) } finally { await sql.end() }
})

// POST /api/shopify/cases/:id/link {order_name} → link a specific order (e.g. the customer emailed from another address)
shopifyApi.post('/cases/:id/link', async (c) => {
  const id = Number(c.req.param('id'))
  const { order_name } = (await c.req.json().catch(() => ({}))) as { order_name?: string }
  const sql = getDb(c.env)
  try {
    const k = await loadCase(sql, id)
    if (!k) return c.json({ error: 'Case not found' }, 404)
    if (k.channel !== 'shopify') return c.json({ error: 'Only Saisales.co.uk cases can be linked to a Shopify order' }, 400)
    const o = await findOrderByName(c.env, sql, String(order_name ?? ''))
    if (!o) return c.json({ error: `No Saisales order ${order_name} on Shopify` }, 404)
    await sql`UPDATE cases SET shopify_order_gid = NULL, order_id = ${o.name} WHERE id = ${id}`
    await attachOrderToCase(sql, id, o)
    await sql`INSERT INTO messages (case_id, direction, sender, body, kind, sent_at) VALUES (${id}, 'inbound', 'ReplyIQ', ${`Shopify order ${o.name} linked by ${c.get('user').name}.`}, 'event', now())`.catch(() => {})
    return c.json({ ok: true, order: o.name })
  } catch (e) { return fail(c, e) } finally { await sql.end() }
})

// ───────── Actions ─────────
async function audit(sql: Sql, a: { case_id: number; order_gid: string; order_name?: string | null; kind: string; amount?: number | null; reason?: string | null; detail?: any; user: number }) {
  const [r] = await sql`INSERT INTO shopify_actions (case_id, order_gid, order_name, kind, amount, currency, reason, detail, created_by)
    VALUES (${a.case_id}, ${a.order_gid}, ${a.order_name ?? null}, ${a.kind}, ${a.amount ?? null}, ${a.amount != null ? 'GBP' : null}, ${a.reason ?? null}, ${sql.json(a.detail ?? {})}, ${a.user}) RETURNING id`
  return r.id as number
}
const finish = (sql: Sql, id: number, ok: boolean, detail: any, error?: string) =>
  sql`UPDATE shopify_actions SET status = ${ok ? 'done' : 'failed'}, detail = detail || ${sql.json(detail ?? {})}, error = ${error ?? null}, finished_at = now() WHERE id = ${id}`
const note = (sql: Sql, caseId: number, text: string) =>
  sql`INSERT INTO messages (case_id, direction, sender, body, kind, sent_at) VALUES (${caseId}, 'inbound', 'ReplyIQ', ${text}, 'event', now())`.catch(() => {})

async function orderForAction(c: any, sql: Sql, id: number) {
  const k = await loadCase(sql, id)
  if (!k) throw new ShopifyError('Case not found', 404)
  if (k.channel !== 'shopify') throw new ShopifyError('This is not a Saisales.co.uk case', 400)
  if (!k.shopify_order_gid) throw new ShopifyError('No Shopify order is linked to this case', 400)
  const o = await getOrder(c.env, sql, k.shopify_order_gid)
  if (!o) throw new ShopifyError('The linked order is no longer on Shopify', 404)
  return { k, o }
}

// POST /api/shopify/cases/:id/refund {amount, reason, notify, confirm_amount, key}
// Agents up to £15; managers any amount. confirm_amount must equal amount (the figure shown on the confirmation screen).
shopifyApi.post('/cases/:id/refund', async (c) => {
  const id = Number(c.req.param('id'))
  const user = c.get('user')
  const b = (await c.req.json().catch(() => ({}))) as { amount?: number | string; reason?: string; notify?: boolean; confirm_amount?: number | string; key?: string }
  const amount = Math.round(Number(b.amount) * 100) / 100
  const reason = String(b.reason ?? '').trim()
  if (!(amount > 0)) return c.json({ error: 'Enter the refund amount' }, 400)
  if (Math.round(Number(b.confirm_amount) * 100) / 100 !== amount) return c.json({ error: 'The amount you confirmed differs from the amount entered. Check it and confirm again.' }, 409)
  if (reason.length < 3) return c.json({ error: 'Give a short reason (it is saved on the Shopify refund and in ReplyIQ)' }, 400)
  const allowed = refundAllowed(user.role, amount)
  if (!allowed.ok) return c.json({ error: allowed.error }, 403)
  const key = /^[A-Za-z0-9-]{16,64}$/.test(String(b.key ?? '')) ? String(b.key) : crypto.randomUUID()
  const sql = getDb(c.env)
  let actionId: number | null = null
  try {
    const { o } = await orderForAction(c, sql, id)
    const plan = await planRefund(c.env, sql, o.id, amount)
    if ('error' in plan) return c.json({ error: plan.error }, 422)
    // Same click twice (same key) → Shopify's idempotency returns the first refund; ReplyIQ refuses to log a second one.
    // A failed attempt may be retried with the same key: Shopify then returns the first result instead of refunding twice.
    const [dup] = await sql`SELECT id, status FROM shopify_actions WHERE kind = 'refund' AND detail->>'key' = ${key} AND status <> 'failed' LIMIT 1`
    if (dup) return c.json({ error: dup.status === 'done' ? 'This refund was already issued.' : 'This refund is already being processed.' }, 409)
    actionId = await audit(sql, { case_id: id, order_gid: o.id, order_name: o.name, kind: 'refund', amount, reason, user: user.id, detail: { key, notify: !!b.notify, split: plan.transactions } })
    const refund = await createRefund(c.env, sql, o.id, plan, { note: `${reason} (ReplyIQ, ${user.name})`, notify: !!b.notify, idempotencyKey: key })
    await finish(sql, actionId, true, { refund_id: refund.id })
    await sql`UPDATE cases SET refund_issued = TRUE, updated_at = now() WHERE id = ${id}`
    await note(sql, id, `Refund of £${amount.toFixed(2)} issued on Shopify (${o.name}) by ${user.name}: ${reason}.${b.notify ? ' Shopify emailed the customer.' : ''} Record the sales credit note.`)
    const fresh = await getOrder(c.env, sql, o.id)
    if (fresh) await attachOrderToCase(sql, id, fresh)
    return c.json({ ok: true, refund_id: refund.id, amount, manual_payment: plan.manualGateway })
  } catch (e: any) {
    if (actionId) await finish(sql, actionId, false, {}, String(e?.message ?? e).slice(0, 500)).catch(() => {})
    return fail(c, e)
  } finally { await sql.end() }
})

// POST /api/shopify/cases/:id/returns {lines:[{fulfillment_line_item_id, quantity}], note}
shopifyApi.post('/cases/:id/returns', async (c) => {
  const id = Number(c.req.param('id'))
  const user = c.get('user')
  const b = (await c.req.json().catch(() => ({}))) as { lines?: { fulfillment_line_item_id: string; quantity: number }[]; note?: string }
  const sql = getDb(c.env)
  let actionId: number | null = null
  try {
    const { o } = await orderForAction(c, sql, id)
    const can = returnableLines(o)
    const lines = (b.lines ?? []).map((l) => ({ fulfillmentLineItemId: String(l.fulfillment_line_item_id), quantity: Math.floor(Number(l.quantity)) })).filter((l) => l.quantity > 0)
    if (!lines.length) return c.json({ error: 'Choose the item(s) coming back' }, 400)
    for (const l of lines) {
      const cl = can.find((x) => x.fulfillmentLineItemId === l.fulfillmentLineItemId)
      if (!cl || l.quantity > cl.quantity) return c.json({ error: 'One of the items cannot be returned (not shipped, or already on a return)' }, 422)
    }
    const why = String(b.note ?? '').trim().slice(0, 255) || 'Return arranged by Saisales customer support'
    actionId = await audit(sql, { case_id: id, order_gid: o.id, order_name: o.name, kind: 'return_open', reason: why, user: user.id, detail: { lines } })
    const r = await openReturn(c.env, sql, o.id, lines, why)
    await finish(sql, actionId, true, { return_id: r.id, return_name: r.name, rfo: r.reverseFulfillmentOrders?.nodes?.[0]?.id ?? null })
    await note(sql, id, `Return ${r.name} opened on Shopify for ${o.name} by ${user.name}. Next: attach the return label.`)
    const fresh = await getOrder(c.env, sql, o.id); if (fresh) await attachOrderToCase(sql, id, fresh)
    return c.json({ ok: true, return: { id: r.id, name: r.name } })
  } catch (e: any) {
    if (actionId) await finish(sql, actionId, false, {}, String(e?.message ?? e).slice(0, 500)).catch(() => {})
    return fail(c, e)
  } finally { await sql.end() }
})

// POST /api/shopify/cases/:id/returns/label {return_id, pdf_base64, filename, tracking_number, notify_customer}
// notify_customer = Shopify emails the label to the customer: that is a message to the customer, so it is off unless ticked.
shopifyApi.post('/cases/:id/returns/label', async (c) => {
  const id = Number(c.req.param('id'))
  const user = c.get('user')
  const b = (await c.req.json().catch(() => ({}))) as { return_id?: string; pdf_base64?: string; filename?: string; tracking_number?: string; notify_customer?: boolean }
  const sql = getDb(c.env)
  let actionId: number | null = null
  try {
    const { o } = await orderForAction(c, sql, id)
    const hit = returnOn(o, String(b.return_id ?? ''))
    if (!hit) return c.json({ error: 'Return not found on this order' }, 404)
    if (hit.ret.status !== 'OPEN' || !hit.rfoId) return c.json({ error: `Return ${hit.ret.name} is ${String(hit.ret.status).toLowerCase()}; a label can only go on an open return` }, 409)
    const raw = String(b.pdf_base64 ?? '').replace(/^data:[^,]+,/, '').replace(/\s+/g, '')
    let pdf: Uint8Array
    try { pdf = Uint8Array.from(atob(raw), (ch) => ch.charCodeAt(0)) } catch { return c.json({ error: 'The label file could not be read' }, 400) }
    if (pdf.byteLength < 200 || String.fromCharCode(...pdf.slice(0, 5)) !== '%PDF-') return c.json({ error: 'The label must be a PDF file' }, 400)
    if (pdf.byteLength > 5 * 1024 * 1024) return c.json({ error: 'The label PDF is over 5 MB' }, 400)
    const tracking = String(b.tracking_number ?? '').trim().toUpperCase().slice(0, 40) || null
    const filename = (String(b.filename ?? '').replace(/[^\w.\- ]+/g, '').slice(0, 80) || `return-label-${o.name.replace('#', '')}.pdf`).replace(/(\.pdf)?$/i, '.pdf')
    actionId = await audit(sql, { case_id: id, order_gid: o.id, order_name: o.name, kind: 'return_label', user: user.id, detail: { return_id: hit.ret.id, tracking, notify: !!b.notify_customer, bytes: pdf.byteLength } })
    const rd = await attachReturnLabel(c.env, sql, { reverseFulfillmentOrderId: hit.rfoId, pdf, filename, trackingNumber: tracking,
      trackingUrl: tracking ? `https://www.royalmail.com/track-your-item#/tracking-results/${encodeURIComponent(tracking)}` : null, notifyCustomer: !!b.notify_customer })
    await finish(sql, actionId, true, { reverse_delivery_id: rd?.id ?? null })
    await note(sql, id, `Return label${tracking ? ` (${tracking})` : ''} added to ${hit.ret.name} by ${user.name}.${b.notify_customer ? ' Shopify emailed it to the customer.' : ' The customer has not been sent it yet.'}`)
    return c.json({ ok: true })
  } catch (e: any) {
    if (actionId) await finish(sql, actionId, false, {}, String(e?.message ?? e).slice(0, 500)).catch(() => {})
    return fail(c, e)
  } finally { await sql.end() }
})

// POST /api/shopify/cases/:id/returns/process {return_id, note} → phone received: close the return (refund is separate)
// POST /api/shopify/cases/:id/returns/cancel  {return_id}       → cancel a return opened by mistake (before any work on it)
for (const act of ['process', 'cancel'] as const) {
  shopifyApi.post(`/cases/:id/returns/${act}`, async (c) => {
    const id = Number(c.req.param('id'))
    const user = c.get('user')
    const b = (await c.req.json().catch(() => ({}))) as { return_id?: string; note?: string }
    const sql = getDb(c.env)
    let actionId: number | null = null
    try {
      const { o } = await orderForAction(c, sql, id)
      const hit = returnOn(o, String(b.return_id ?? ''))
      if (!hit) return c.json({ error: 'Return not found on this order' }, 404)
      actionId = await audit(sql, { case_id: id, order_gid: o.id, order_name: o.name, kind: act === 'process' ? 'return_process' : 'return_cancel', reason: b.note ?? null, user: user.id, detail: { return_id: hit.ret.id } })
      if (act === 'process') await processReturn(c.env, sql, hit.ret.id, String(b.note ?? 'Received and checked').slice(0, 500))
      else await cancelReturn(c.env, sql, hit.ret.id)
      await finish(sql, actionId, true, {})
      await note(sql, id, act === 'process' ? `Return ${hit.ret.name} marked as received on Shopify by ${user.name}. Issue the refund once the inspection is agreed.` : `Return ${hit.ret.name} cancelled on Shopify by ${user.name}.`)
      const fresh = await getOrder(c.env, sql, o.id); if (fresh) await attachOrderToCase(sql, id, fresh)
      return c.json({ ok: true })
    } catch (e: any) {
      if (actionId) await finish(sql, actionId, false, {}, String(e?.message ?? e).slice(0, 500)).catch(() => {})
      return fail(c, e)
    } finally { await sql.end() }
  })
}
