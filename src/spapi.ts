// Amazon Selling Partner API — private, self-authorised app for Saigates' own seller account.
// Roles used: "Inventory and Order Tracking" + "Buyer Solicitation". We NEVER request BUYER / RECIPIENT
// datasets (the PII), so no restricted-data roles are needed.
//
// Orders API version: v2026-01-01 (v0 is deprecated per developer-docs.amazon.com, checked 2026-10-12).
//   GET /orders/2026-01-01/orders/{orderId}?includedData=FULFILLMENT,PACKAGES,PROCEEDS   (0.5 req/s, burst 30)
// Solicitations API v1:
//   GET  /solicitations/v1/orders/{orderId}?marketplaceIds=…                              (1 req/s, burst 5)
//   POST /solicitations/v1/orders/{orderId}/solicitations/productReviewAndSellerFeedback?marketplaceIds=…
// Auth: LWA refresh token → bearer access token (no AWS SigV4 since 2023).
import type { Bindings } from './db'

export const SPAPI_ENDPOINT = 'https://sellingpartnerapi-eu.amazon.com'
export const MARKETPLACE_UK = 'A1F83G8C2ARO7P'
const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token'

export type SpapiEnv = Bindings & { SPAPI_LWA_CLIENT_ID?: string; SPAPI_LWA_CLIENT_SECRET?: string; SPAPI_REFRESH_TOKEN?: string }

export const spapiConfigured = (env: SpapiEnv) => !!(env.SPAPI_LWA_CLIENT_ID && env.SPAPI_LWA_CLIENT_SECRET && env.SPAPI_REFRESH_TOKEN)

export class SpapiError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message) }
}

// Access token cache (per isolate; LWA tokens last 3600 s)
let cached: { token: string; exp: number } | null = null
export async function lwaAccessToken(env: SpapiEnv): Promise<string> {
  if (!spapiConfigured(env)) throw new SpapiError(0, 'SP-API is not configured (SPAPI_LWA_CLIENT_ID / SPAPI_LWA_CLIENT_SECRET / SPAPI_REFRESH_TOKEN secrets missing)')
  if (cached && cached.exp > Date.now() + 60_000) return cached.token
  const res = await fetch(LWA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: env.SPAPI_REFRESH_TOKEN!, client_id: env.SPAPI_LWA_CLIENT_ID!, client_secret: env.SPAPI_LWA_CLIENT_SECRET! }),
  })
  const data: any = await res.json().catch(() => ({}))
  if (!res.ok || !data.access_token) throw new SpapiError(res.status, `LWA token exchange failed: ${data.error_description || data.error || res.status}`)
  cached = { token: data.access_token, exp: Date.now() + (Number(data.expires_in) || 3600) * 1000 }
  return cached.token
}

async function spapi<T>(env: SpapiEnv, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const token = await lwaAccessToken(env)
  const res = await fetch(`${SPAPI_ENDPOINT}${path}`, {
    method,
    headers: { 'x-amz-access-token': token, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data: any = {}
  try { data = text ? JSON.parse(text) : {} } catch { data = { raw: text.slice(0, 300) } }
  if (!res.ok) {
    const e = data?.errors?.[0]
    throw new SpapiError(res.status, e?.message || data?.raw || `SP-API ${res.status}`, e?.code)
  }
  return data as T
}

// ───────── Orders v2026-01-01 ─────────
export type OrderSummary = {
  orderId: string
  orderDate: string | null
  status: string | null
  fulfilledBy: string | null
  items: { title: string | null; asin: string | null; sku: string | null; quantity: number; unitPrice: string | null; currency: string | null; condition: string | null }[]
  grandTotal: string | null
  currency: string | null
  shipDate: string | null
  carrier: string | null
  trackingNumber: string | null
  packageStatus: string | null
  deliveredAt: string | null // ACTUAL delivery (package status DELIVERED) — may be null
  promisedDelivery: { earliest: string | null; latest: string | null } // promised window (estimate)
  deliveryDate: string | null // YYYY-MM-DD: actual if known, else promised latest
  deliveryIsEstimate: boolean
  fetchedAt: string
}

const money = (m: any) => (m && m.amount != null ? String(m.amount) : null)

export async function fetchOrder(env: SpapiEnv, orderId: string): Promise<OrderSummary> {
  if (!/^\d{3}-\d{7}-\d{7}$/.test(orderId)) throw new SpapiError(400, 'Not a valid Amazon order ID')
  // includedData deliberately excludes BUYER and RECIPIENT (PII).
  const o: any = await spapi<any>(env, 'GET', `/orders/2026-01-01/orders/${orderId}?includedData=FULFILLMENT,PACKAGES,PROCEEDS`)
  const order = o.order ?? o.payload ?? o
  const pkgs: any[] = order.packages ?? []
  const delivered = pkgs.find((p) => String(p.packageStatus?.status ?? '').toUpperCase() === 'DELIVERED')
  const first = pkgs[0]
  // Actual delivery timestamp: v2026-01-01 exposes packageStatus; some payloads carry a statusTime/lastUpdatedTime
  const deliveredAt: string | null = delivered ? delivered.packageStatus?.statusTime ?? delivered.packageStatus?.lastUpdatedTime ?? delivered.deliveredTime ?? null : null
  const win = order.fulfillment?.deliverByWindow ?? {}
  const promised = { earliest: win.earliestDateTime ?? null, latest: win.latestDateTime ?? null }
  const deliveryIsEstimate = !deliveredAt
  const deliverySrc = deliveredAt ?? (delivered ? null : promised.latest) // if DELIVERED but no time, leave null rather than guess
  const items = (order.orderItems ?? []).map((it: any) => ({
    title: it.product?.title ?? null,
    asin: it.product?.asin ?? null,
    sku: it.product?.sellerSku ?? null,
    quantity: Number(it.quantityOrdered ?? 1),
    unitPrice: money(it.product?.price?.unitPrice),
    currency: it.product?.price?.unitPrice?.currencyCode ?? null,
    condition: [it.product?.condition?.conditionType, it.product?.condition?.conditionSubtype].filter(Boolean).join(' / ') || null,
  }))
  return {
    orderId: order.orderId ?? orderId,
    orderDate: order.createdTime ?? null,
    status: order.fulfillment?.fulfillmentStatus ?? null,
    fulfilledBy: order.fulfillment?.fulfilledBy ?? null,
    items,
    grandTotal: money(order.proceeds?.grandTotal),
    currency: order.proceeds?.grandTotal?.currencyCode ?? null,
    shipDate: first?.shipTime ?? null,
    carrier: first?.carrier ?? null,
    trackingNumber: first?.trackingNumber ?? null,
    packageStatus: first?.packageStatus?.status ?? null,
    deliveredAt,
    promisedDelivery: promised,
    deliveryDate: deliverySrc ? new Date(deliverySrc).toISOString().slice(0, 10) : null,
    deliveryIsEstimate,
    fetchedAt: new Date().toISOString(),
  }
}

// ───────── Solicitations v1 ─────────
export async function reviewRequestEligible(env: SpapiEnv, orderId: string): Promise<{ eligible: boolean; actions: string[] }> {
  const r: any = await spapi<any>(env, 'GET', `/solicitations/v1/orders/${orderId}?marketplaceIds=${MARKETPLACE_UK}`)
  const actions: string[] = (r._links?.actions ?? []).map((a: any) => a.name).filter(Boolean)
  return { eligible: actions.includes('productReviewAndSellerFeedback'), actions }
}

export async function sendReviewRequest(env: SpapiEnv, orderId: string): Promise<{ ok: true }> {
  await spapi<any>(env, 'POST', `/solicitations/v1/orders/${orderId}/solicitations/productReviewAndSellerFeedback?marketplaceIds=${MARKETPLACE_UK}`, {})
  return { ok: true }
}

/** Connection test: exchanges the refresh token only (no order data touched). */
export async function testConnection(env: SpapiEnv): Promise<{ ok: boolean; detail: string }> {
  try { await lwaAccessToken(env); return { ok: true, detail: 'LWA token exchange succeeded' } }
  catch (e: any) { return { ok: false, detail: e.message } }
}
