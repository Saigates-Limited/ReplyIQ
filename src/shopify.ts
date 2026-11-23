// Shopify (Saisales.co.uk) — Admin GraphQL client, order lookup and the actions staff can take from a case.
//
// Auth: a Dev Dashboard app installed on the Saisales store, client credentials grant (Shopify, 2026): the Worker swaps
// SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET for a 24-hour access token and caches it (encrypted with TOKEN_ENC_KEY) in
// app_settings so every request does not fetch a new one. Secrets: SHOPIFY_SHOP (e.g. "a6fdb4" or "a6fdb4.myshopify.com"),
// SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET. Nothing is configured from the browser.
//
// Privacy: orderFacts() is the ONLY order data that reaches OpenAI. It holds no name, email, phone or address.
import type { Bindings, Sql } from './db'
import { encryptToken, decryptToken } from './gmail'

export const SHOPIFY_API_VERSION = '2026-10'
/** Scopes the Dev Dashboard app needs (shown on the Settings card). read_all_orders: orders older than 60 days. */
export const SHOPIFY_SCOPES = ['read_orders', 'read_all_orders', 'write_orders', 'read_customers', 'read_returns', 'write_returns']

export class ShopifyError extends Error {
  constructor(msg: string, public status = 502, public userErrors: { field?: string[] | null; message: string }[] = []) { super(msg); this.name = 'ShopifyError' }
}

export const shopifyConfigured = (env: Bindings) => Boolean(env.SHOPIFY_SHOP && env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET)
export function shopDomain(env: Bindings) {
  const s = String(env.SHOPIFY_SHOP ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  if (!s) throw new ShopifyError('SHOPIFY_SHOP is not configured', 503)
  const d = s.endsWith('.myshopify.com') ? s : `${s}.myshopify.com`
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(d)) throw new ShopifyError('SHOPIFY_SHOP must be the store\'s myshopify.com name', 503)
  return d
}

// ───────── Access token (client credentials grant, 24 h) ─────────
let memToken: { token: string; exp: number; shop: string } | null = null
const TOKEN_KEY = 'shopify_token'

async function fetchNewToken(env: Bindings) {
  const res = await fetch(`https://${shopDomain(env)}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.SHOPIFY_CLIENT_ID!, client_secret: env.SHOPIFY_CLIENT_SECRET! }),
  })
  const j: any = await res.json().catch(() => ({}))
  if (!res.ok || !j.access_token) throw new ShopifyError(`Shopify token request failed (${res.status}): ${j.error_description || j.error || 'no access token'}`, res.status === 400 || res.status === 401 ? 503 : 502)
  return { token: String(j.access_token), exp: Date.now() + (Number(j.expires_in) || 86399) * 1000, scope: String(j.scope ?? '') }
}

export async function shopifyToken(env: Bindings, sql: Sql | null, force = false): Promise<string> {
  if (!shopifyConfigured(env)) throw new ShopifyError('Shopify is not connected (SHOPIFY_SHOP / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET are not set)', 503)
  const shop = shopDomain(env)
  const fresh = (t: { exp: number; shop: string } | null) => !!t && t.shop === shop && t.exp - Date.now() > 10 * 60_000
  if (!force && fresh(memToken)) return memToken!.token
  if (!force && sql && env.TOKEN_ENC_KEY) {
    try {
      const [r] = await sql`SELECT value FROM app_settings WHERE key = ${TOKEN_KEY}`
      const v = (typeof r?.value === 'string' ? JSON.parse(r.value) : r?.value) as { enc: string; exp: number; shop: string } | undefined
      if (v && fresh(v)) { memToken = { token: await decryptToken(env, v.enc), exp: v.exp, shop: v.shop }; return memToken.token }
    } catch { /* fall through to a new token */ }
  }
  const t = await fetchNewToken(env)
  memToken = { token: t.token, exp: t.exp, shop }
  if (sql && env.TOKEN_ENC_KEY) {
    const value = { enc: await encryptToken(env, t.token), exp: t.exp, shop, scope: t.scope }
    await sql`INSERT INTO app_settings (key, value, updated_at) VALUES (${TOKEN_KEY}, ${sql.json(value as any)}, now())
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`.catch(() => {})
  }
  return t.token
}

/** One Admin GraphQL call. Retries once with a new token on 401, and once after a throttle. */
export async function shopifyGql<T = any>(env: Bindings, sql: Sql | null, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const call = async (token: string) => fetch(`https://${shopDomain(env)}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  })
  let res = await call(await shopifyToken(env, sql))
  if (res.status === 401) res = await call(await shopifyToken(env, sql, true))
  let j: any = await res.json().catch(() => ({}))
  const throttled = (x: any) => res.status === 429 || (x?.errors ?? []).some((e: any) => e?.extensions?.code === 'THROTTLED')
  if (throttled(j)) {
    await new Promise((r) => setTimeout(r, 1500))
    res = await call(await shopifyToken(env, sql)); j = await res.json().catch(() => ({}))
  }
  if (!res.ok) throw new ShopifyError(`Shopify API error ${res.status}: ${j?.errors ? JSON.stringify(j.errors).slice(0, 300) : res.statusText}`, res.status === 403 ? 403 : 502)
  if (j.errors?.length) {
    const msg = j.errors.map((e: any) => e.message).join('; ')
    throw new ShopifyError(/access denied|scope/i.test(msg) ? `Shopify refused: ${msg}. Check the app's access scopes (${SHOPIFY_SCOPES.join(', ')}).` : `Shopify: ${msg}`, /access denied/i.test(msg) ? 403 : 502)
  }
  return j.data as T
}

// ───────── Order lookup ─────────
const ORDER_FIELDS = `
  id name createdAt processedAt cancelledAt cancelReason closed displayFinancialStatus displayFulfillmentStatus returnStatus sourceName email
  currencyCode
  currentTotalPriceSet { shopMoney { amount currencyCode } }
  totalRefundedSet { shopMoney { amount currencyCode } }
  customer { firstName lastName }
  shippingAddress { firstName lastName name company address1 address2 city province zip country }
  billingAddress { name company address1 address2 city province zip country }
  lineItems(first: 20) { nodes { id title variantTitle sku quantity currentQuantity refundableQuantity originalUnitPriceSet { shopMoney { amount } } } }
  fulfillments(first: 10) { id createdAt status displayStatus deliveredAt estimatedDeliveryAt inTransitAt trackingInfo { company number url }
    fulfillmentLineItems(first: 20) { nodes { id quantity lineItem { id title } } } }
  refunds(first: 20) { id createdAt note totalRefundedSet { shopMoney { amount } } }
  returns(first: 10) { nodes { id name status createdAt closedAt totalQuantity
    returnLineItems(first: 20) { nodes { id quantity ... on ReturnLineItem { fulfillmentLineItem { id lineItem { title } } } } }
    reverseFulfillmentOrders(first: 5) { nodes { id status reverseDeliveries(first: 5) { nodes { id deliverable { ... on ReverseDeliveryShippingDeliverable { tracking { number url carrierName } label { publicFileUrl } } } } } } } } }
  transactions(first: 20) { id kind status gateway formattedGateway manualPaymentGateway test createdAt amountSet { shopMoney { amount currencyCode } } }
`

export type ShopifyOrder = any // raw Admin API order (staff-facing; contains PII)

export async function getOrder(env: Bindings, sql: Sql | null, gid: string): Promise<ShopifyOrder | null> {
  const d = await shopifyGql(env, sql, `query($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`, { id: gid })
  return d.order ?? null
}

/** "#1094", "1094", "SS1094" → "#1094" (order names on this store are #NNNN). */
export function normaliseOrderName(v: string | null | undefined): string | null {
  const m = String(v ?? '').match(/#?\s*(\d{3,7})\b/)
  return m ? `#${m[1]}` : null
}

export async function findOrderByName(env: Bindings, sql: Sql | null, name: string): Promise<ShopifyOrder | null> {
  const n = normaliseOrderName(name)
  if (!n) return null
  const d = await shopifyGql(env, sql, `query($q: String!) { orders(first: 1, query: $q) { nodes { ${ORDER_FIELDS} } } }`, { q: `name:${n}` })
  const o = d.orders?.nodes?.[0] ?? null
  return o && o.name === n ? o : null
}

/** Latest orders placed with this email address (newest first). */
export async function findOrdersByEmail(env: Bindings, sql: Sql | null, email: string, max = 5): Promise<ShopifyOrder[]> {
  const e = String(email).trim().toLowerCase()
  if (!/^[^\s@"']+@[^\s@"']+\.[^\s@"']+$/.test(e)) return []
  const d = await shopifyGql(env, sql, `query($q: String!, $n: Int!) { orders(first: $n, query: $q, sortKey: CREATED_AT, reverse: true) { nodes { ${ORDER_FIELDS} } } }`, { q: `email:"${e}"`, n: max })
  return (d.orders?.nodes ?? []).filter((o: any) => String(o.email ?? '').toLowerCase() === e)
}

// ───────── Order references in customer text ─────────
/** Order numbers a customer quotes: "#1094", "order 1094", "order no. 1094", "Order #1094". Returns "#NNNN" values, de-duplicated. */
export function orderRefsInText(text: string): string[] {
  const out = new Set<string>()
  const t = String(text ?? '')
  for (const m of t.matchAll(/(?:^|[\s(\[:])#\s?(\d{4,6})\b/g)) out.add(`#${m[1]}`)
  for (const m of t.matchAll(/\border\s*(?:no\.?|number|num|ref(?:erence)?|id)?\s*[:#]?\s*(\d{4,6})\b/gi)) out.add(`#${m[1]}`)
  return [...out]
}

// ───────── What the AI and the case page see ─────────
const money = (v: any) => (v == null || v === '' ? null : Number(v).toFixed(2))
const day = (v: any) => (v ? String(v).slice(0, 10) : null)

export type OrderFacts = {
  order: string
  placed: string | null
  status: { payment: string; fulfilment: string; returns: string; cancelled: boolean; closed: boolean }
  total: string | null
  refunded: string | null
  currency: string
  items: { title: string; variant: string | null; qty: number; unit_price: string | null }[]
  shipments: { sent: string | null; status: string | null; carrier: string | null; tracking: string | null; delivered: string | null; estimated: string | null }[]
  refunds: { date: string | null; amount: string | null; note: string | null }[]
  returns: { name: string; status: string; opened: string | null; closed: string | null; label_sent: boolean; return_tracking: string | null }[]
  paid_via: string[]
  channel: string
}

/** Non-PII summary of an order: no customer name, email, phone or address (privacy rule; this is what OpenAI may see). */
export function orderFacts(o: ShopifyOrder): OrderFacts {
  const rd = (r: any) => (r.reverseFulfillmentOrders?.nodes ?? []).flatMap((x: any) => x.reverseDeliveries?.nodes ?? [])
  return {
    order: o.name,
    placed: day(o.processedAt ?? o.createdAt),
    status: { payment: o.displayFinancialStatus ?? 'UNKNOWN', fulfilment: o.displayFulfillmentStatus ?? 'UNKNOWN', returns: o.returnStatus ?? 'NO_RETURN', cancelled: !!o.cancelledAt, closed: !!o.closed },
    total: money(o.currentTotalPriceSet?.shopMoney?.amount),
    refunded: money(o.totalRefundedSet?.shopMoney?.amount),
    currency: o.currencyCode ?? o.currentTotalPriceSet?.shopMoney?.currencyCode ?? 'GBP',
    items: (o.lineItems?.nodes ?? []).map((li: any) => ({ title: li.title, variant: li.variantTitle ?? null, qty: li.quantity, unit_price: money(li.originalUnitPriceSet?.shopMoney?.amount) })),
    shipments: (o.fulfillments ?? []).map((f: any) => ({
      sent: day(f.createdAt), status: f.displayStatus ?? f.status ?? null,
      carrier: f.trackingInfo?.[0]?.company ?? null, tracking: f.trackingInfo?.[0]?.number ?? null,
      delivered: day(f.deliveredAt), estimated: day(f.estimatedDeliveryAt),
    })),
    refunds: (o.refunds ?? []).map((r: any) => ({ date: day(r.createdAt), amount: money(r.totalRefundedSet?.shopMoney?.amount), note: r.note ? String(r.note).slice(0, 200) : null })),
    returns: (o.returns?.nodes ?? []).map((r: any) => ({
      name: r.name, status: r.status, opened: day(r.createdAt), closed: day(r.closedAt),
      label_sent: rd(r).some((d: any) => d.deliverable?.label?.publicFileUrl),
      return_tracking: rd(r).map((d: any) => d.deliverable?.tracking?.number).find(Boolean) ?? null,
    })),
    paid_via: [...new Set((o.transactions ?? []).filter((t: any) => ['SALE', 'CAPTURE'].includes(t.kind) && t.status === 'SUCCESS').map((t: any) => t.formattedGateway || t.gateway))] as string[],
    channel: o.sourceName === 'web' ? 'Saisales.co.uk website' : o.sourceName === 'shopify_draft_order' ? 'Draft order' : `Other sales channel (${o.sourceName ?? 'unknown'})`,
  }
}

/** Delivery date for the case's warranty / return-window maths: the latest delivered fulfilment. */
export function deliveredDate(o: ShopifyOrder): string | null {
  const d = (o.fulfillments ?? []).map((f: any) => f.deliveredAt).filter(Boolean).sort().pop()
  return d ? String(d).slice(0, 10) : null
}

/** Staff-facing address lines (for invoices and carrier claims). Never sent to OpenAI. */
export function addressLines(a: any): string[] {
  if (!a) return []
  return [a.name, a.company, a.address1, a.address2, a.city, a.province, a.zip, a.country].map((x) => String(x ?? '').trim()).filter(Boolean)
}

/** Store the order on the case: gid, non-PII facts, delivery date / tracking if staff have not set them. */
export async function attachOrderToCase(sql: Sql, caseId: number, o: ShopifyOrder) {
  const f = orderFacts(o)
  const ship = (o.fulfillments ?? []).find((x: any) => x.trackingInfo?.[0]?.number)
  const delivered = deliveredDate(o)
  await sql`UPDATE cases SET shopify_order_gid = ${o.id}, shopify_order = ${sql.json(f as any)}, shopify_synced_at = now(),
              order_id = COALESCE(order_id, ${o.name}),
              device_model = COALESCE(device_model, ${o.lineItems?.nodes?.[0]?.title ?? null}),
              tracking_number = COALESCE(tracking_number, ${ship?.trackingInfo?.[0]?.number ?? null}),
              carrier = COALESCE(carrier, ${ship?.trackingInfo?.[0]?.company ?? null}),
              delivery_date = COALESCE(delivery_date, ${delivered}),
              refund_issued = CASE WHEN ${Number(f.refunded ?? 0) > 0} THEN TRUE ELSE refund_issued END,
              updated_at = now()
            WHERE id = ${caseId}`
  if (delivered) await sql`UPDATE cases SET delivery_date_source = 'shopify_delivered' WHERE id = ${caseId} AND delivery_date = ${delivered} AND delivery_date_source IS NULL`.catch(() => {})
  return f
}

// ───────── Refunds ─────────
/** Agents may refund up to this much on their own (same rule as Amazon goodwill refunds); above it a manager must do it. */
export const AGENT_REFUND_LIMIT = 15

export type RefundPlan = { amount: number; maxRefundable: number; transactions: { gateway: string; amount: number; parentId: string | null }[]; manualGateway: boolean }

/** How a refund of `amount` is split over the order's payments (Shopify's suggested refund), or why it can't be done. */
export async function planRefund(env: Bindings, sql: Sql | null, orderGid: string, amount: number): Promise<RefundPlan | { error: string }> {
  const d = await shopifyGql(env, sql, `query($id: ID!) { order(id: $id) {
      transactions(first: 20) { gateway kind status manualPaymentGateway }
      suggestedRefund(refundLineItems: [], suggestFullRefund: true) {
        maximumRefundableSet { shopMoney { amount } }
        suggestedTransactions { gateway kind maximumRefundableSet { shopMoney { amount } } parentTransaction { id } } } } }`, { id: orderGid })
  const sr = d.order?.suggestedRefund
  if (!sr) return { error: 'Order not found on Shopify' }
  return splitRefund(amount, Number(sr.maximumRefundableSet?.shopMoney?.amount ?? 0), (sr.suggestedTransactions ?? []).map((t: any) => ({
    gateway: t.gateway, max: Number(t.maximumRefundableSet?.shopMoney?.amount ?? 0), parentId: t.parentTransaction?.id ?? null,
  })), (d.order.transactions ?? []).some((t: any) => t.manualPaymentGateway && ['SALE', 'CAPTURE'].includes(t.kind)))
}

/** Pure: spread a refund over the refundable payments, largest first. */
export function splitRefund(amount: number, maxRefundable: number, sources: { gateway: string; max: number; parentId: string | null }[], manualGateway = false): RefundPlan | { error: string } {
  const a = Math.round(amount * 100) / 100
  if (!(a > 0)) return { error: 'Enter an amount above £0' }
  if (a > maxRefundable + 0.001) return { error: `£${a.toFixed(2)} is more than can be refunded on this order (£${maxRefundable.toFixed(2)})` }
  let left = a
  const transactions: RefundPlan['transactions'] = []
  for (const s of [...sources].sort((x, y) => y.max - x.max)) {
    if (left <= 0) break
    const take = Math.min(left, s.max)
    if (take > 0) { transactions.push({ gateway: s.gateway, amount: Math.round(take * 100) / 100, parentId: s.parentId }); left = Math.round((left - take) * 100) / 100 }
  }
  if (left > 0.001) return { error: 'Shopify has no payment left on this order to refund that amount to' }
  return { amount: a, maxRefundable, transactions, manualGateway }
}

/** Who may refund this much: agents up to £15, managers any amount. */
export function refundAllowed(role: string, amount: number): { ok: true } | { ok: false; error: string } {
  if (role === 'manager') return { ok: true }
  if (amount <= AGENT_REFUND_LIMIT + 0.001) return { ok: true }
  return { ok: false, error: `Refunds above £${AGENT_REFUND_LIMIT} need a manager. Ask a manager to issue this refund.` }
}

export async function createRefund(env: Bindings, sql: Sql | null, orderGid: string, plan: RefundPlan, opts: { note: string; notify: boolean; idempotencyKey: string }) {
  const d = await shopifyGql(env, sql, `mutation($input: RefundInput!, $key: String!) {
      refundCreate(input: $input) @idempotent(key: $key) { refund { id createdAt totalRefundedSet { shopMoney { amount currencyCode } } } userErrors { field message } } }`, {
    key: opts.idempotencyKey,
    input: {
      orderId: orderGid, note: opts.note.slice(0, 500), notify: opts.notify,
      transactions: plan.transactions.map((t) => ({ orderId: orderGid, gateway: t.gateway, kind: 'REFUND', amount: t.amount.toFixed(2), ...(t.parentId ? { parentId: t.parentId } : {}) })),
    },
  })
  const r = d.refundCreate
  if (r?.userErrors?.length) throw new ShopifyError(r.userErrors.map((e: any) => e.message).join('; '), 422, r.userErrors)
  if (!r?.refund) throw new ShopifyError('Shopify did not return the refund')
  return r.refund as { id: string; createdAt: string; totalRefundedSet: { shopMoney: { amount: string; currencyCode: string } } }
}

// ───────── Returns ─────────
/** Fulfilled lines that can still go into a return (fulfilled quantity minus anything already on a return). */
export function returnableLines(o: ShopifyOrder): { fulfillmentLineItemId: string; title: string; quantity: number }[] {
  const onReturn = new Map<string, number>()
  for (const r of o.returns?.nodes ?? []) {
    if (['CANCELED', 'DECLINED'].includes(r.status)) continue
    for (const li of r.returnLineItems?.nodes ?? []) { const id = li.fulfillmentLineItem?.id; if (id) onReturn.set(id, (onReturn.get(id) ?? 0) + (li.quantity ?? 0)) }
  }
  const out: { fulfillmentLineItemId: string; title: string; quantity: number }[] = []
  for (const f of o.fulfillments ?? []) for (const fli of f.fulfillmentLineItems?.nodes ?? []) {
    const q = (fli.quantity ?? 0) - (onReturn.get(fli.id) ?? 0)
    if (q > 0) out.push({ fulfillmentLineItemId: fli.id, title: fli.lineItem?.title ?? 'Item', quantity: q })
  }
  return out
}

export async function openReturn(env: Bindings, sql: Sql | null, orderGid: string, lines: { fulfillmentLineItemId: string; quantity: number }[], note: string) {
  const d = await shopifyGql(env, sql, `mutation($input: ReturnInput!) { returnCreate(returnInput: $input) {
      return { id name status reverseFulfillmentOrders(first: 5) { nodes { id } } } userErrors { field message } } }`, {
    input: { orderId: orderGid, returnLineItems: lines.map((l) => ({ fulfillmentLineItemId: l.fulfillmentLineItemId, quantity: l.quantity, returnReasonNote: note.slice(0, 255) })) },
  })
  const r = d.returnCreate
  if (r?.userErrors?.length) throw new ShopifyError(r.userErrors.map((e: any) => e.message).join('; '), 422, r.userErrors)
  if (!r?.return) throw new ShopifyError('Shopify did not return the new return')
  return r.return as { id: string; name: string; status: string; reverseFulfillmentOrders: { nodes: { id: string }[] } }
}

export async function cancelReturn(env: Bindings, sql: Sql | null, returnGid: string) {
  const d = await shopifyGql(env, sql, `mutation($id: ID!) { returnCancel(id: $id) { return { id status } userErrors { field message } } }`, { id: returnGid })
  const r = d.returnCancel
  if (r?.userErrors?.length) throw new ShopifyError(r.userErrors.map((e: any) => e.message).join('; '), 422, r.userErrors)
  return r?.return
}

/** Upload the label PDF to Shopify (staged upload), then attach it + tracking to the return's reverse fulfilment order. */
export async function attachReturnLabel(env: Bindings, sql: Sql | null, args: { reverseFulfillmentOrderId: string; pdf: Uint8Array; filename: string; trackingNumber?: string | null; trackingUrl?: string | null; notifyCustomer: boolean }) {
  const st = await shopifyGql(env, sql, `mutation($input: [StagedUploadInput!]!) { stagedUploadsCreate(input: $input) {
      stagedTargets { url resourceUrl parameters { name value } } userErrors { field message } } }`, {
    input: [{ resource: 'RETURN_LABEL', filename: args.filename, mimeType: 'application/pdf', httpMethod: 'POST', fileSize: String(args.pdf.byteLength) }],
  })
  const target = st.stagedUploadsCreate?.stagedTargets?.[0]
  if (st.stagedUploadsCreate?.userErrors?.length || !target) throw new ShopifyError(`Label upload refused: ${(st.stagedUploadsCreate?.userErrors ?? []).map((e: any) => e.message).join('; ') || 'no upload target'}`, 422)
  const form = new FormData()
  for (const p of target.parameters ?? []) form.append(p.name, p.value)
  form.append('file', new Blob([args.pdf as any], { type: 'application/pdf' }), args.filename)
  const up = await fetch(target.url, { method: 'POST', body: form })
  if (!up.ok) throw new ShopifyError(`Label upload failed (${up.status})`)
  const d = await shopifyGql(env, sql, `mutation($rfo: ID!, $label: ReverseDeliveryLabelInput, $tracking: ReverseDeliveryTrackingInput, $notify: Boolean) {
      reverseDeliveryCreateWithShipping(reverseFulfillmentOrderId: $rfo, reverseDeliveryLineItems: [], labelInput: $label, trackingInput: $tracking, notifyCustomer: $notify) {
        reverseDelivery { id } userErrors { field message } } }`, {
    rfo: args.reverseFulfillmentOrderId,
    label: { fileUrl: target.resourceUrl },
    tracking: args.trackingNumber ? { number: args.trackingNumber, ...(args.trackingUrl ? { url: args.trackingUrl } : {}) } : null,
    notify: args.notifyCustomer,
  })
  const r = d.reverseDeliveryCreateWithShipping
  if (r?.userErrors?.length) throw new ShopifyError(r.userErrors.map((e: any) => e.message).join('; '), 422, r.userErrors)
  return r?.reverseDelivery as { id: string }
}

/** Phone is back: mark the return's items as received and close the return. The refund is a separate step (refund button). */
export async function processReturn(env: Bindings, sql: Sql | null, returnGid: string, note: string) {
  const q = await shopifyGql(env, sql, `query($id: ID!) { return(id: $id) { id status returnLineItems(first: 20) { nodes { id quantity ... on ReturnLineItem { processedQuantity } } } } }`, { id: returnGid })
  const ret = q.return
  if (!ret) throw new ShopifyError('Return not found on Shopify', 404)
  if (ret.status !== 'OPEN') throw new ShopifyError(`This return is ${String(ret.status).toLowerCase()}, not open`, 409)
  const lines = (ret.returnLineItems?.nodes ?? []).map((li: any) => ({ id: li.id, quantity: (li.quantity ?? 0) - (li.processedQuantity ?? 0) })).filter((l: any) => l.quantity > 0)
  if (!lines.length) throw new ShopifyError('Every item on this return has already been processed', 409)
  const d = await shopifyGql(env, sql, `mutation($input: ReturnProcessInput!) { returnProcess(input: $input) { return { id status } userErrors { field message } } }`, {
    input: { returnId: returnGid, returnLineItems: lines, notifyCustomer: false, note: note.slice(0, 500) },
  })
  const r = d.returnProcess
  if (r?.userErrors?.length) throw new ShopifyError(r.userErrors.map((e: any) => e.message).join('; '), 422, r.userErrors)
  return r?.return as { id: string; status: string }
}

/** Find a return on the order and the reverse fulfilment order a label goes on. */
export function returnOn(o: ShopifyOrder, returnGid: string) {
  const r = (o.returns?.nodes ?? []).find((x: any) => x.id === returnGid)
  return r ? { ret: r, rfoId: r.reverseFulfillmentOrders?.nodes?.[0]?.id ?? null } : null
}
