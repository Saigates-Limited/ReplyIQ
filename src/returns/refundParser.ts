// Parser for Amazon "Refund Initiated for Order <id>" emails (sender donotreply@amazon.com).
// Pure: text in → structured out. The buyer's name is stripped and never stored.
//
// Real layout (Nov 2026, from the live mailbox): the refund table arrives as a block of LABELS followed by a block of
// VALUES in the same order, e.g.
//     Item name / ASIN / SKU / Return quantity / Item price refund / Outbound delivery cost refund / Refund reason
//     Apple iPhone 15 … / B0CW114X7P / I15-128-PNK-A-AMZ1 / 1 / GBP 359.00 / GBP 0.00 / Buyer Cancelled
// The old regex parser let "\s*" run across the newline after a label, so Reason picked up the product name and SKU
// picked up "Return". This version walks the lines and assigns values to labels in order, so it handles all three
// shapes Amazon's HTML flattens to: "Label: value" inline, label / value alternating, and labels-block then values-block.
// Fixtures: tests/fixtures/refund_*.txt (redacted real emails).

export const ORDER_RE = /\b(\d{3}-\d{7}-\d{7})\b/

export type RefundItem = {
  name: string | null
  asin: string | null
  sku: string | null
  quantity: number | null
  item_refund: number | null       // item price refund
  delivery_refund: number | null   // outbound delivery cost refund
  reason: string | null
}

export type ParsedRefund = {
  orderId: string | null
  amount: number | null
  currency: string | null
  spcRef: string | null
  items: RefundItem[]
  reason: string | null            // overall reason (first item's, or a reason found in the body)
  knownReason: boolean             // 'Buyer Cancelled' | 'Customer Return'
  excerpt: string                  // redacted, for the timeline. Never contains the buyer's name.
}

export const KNOWN_REASONS = ['buyer cancelled', 'customer return']
/** Spelling/format variants Amazon uses → canonical */
export function canonicalReason(r: string | null | undefined): string | null {
  if (!r) return null
  const s = r.trim().replace(/[.\s]+$/, '')
  const k = s.toLowerCase().replace(/\s+/g, ' ')
  if (/^buyer cancel+ed$/.test(k)) return 'Buyer Cancelled'
  if (/^customer return$/.test(k)) return 'Customer Return'
  return s
}

const norm = (s: string) => s.replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n')
const money = (s: string | undefined | null) => { if (s == null) return null; const n = Number(String(s).replace(/[,£$€]|GBP|EUR|USD/gi, '').trim()); return Number.isFinite(n) ? n : null }
const CUR = '(GBP|EUR|USD|£|€|\\$)'
const MONEY_RE = new RegExp(`^${CUR}?\\s*([\\d,]+(?:\\.\\d{1,2})?)\\s*${CUR}?$`, 'i')

/** "We initiated a refund of GBP 359.00 to Jane Smith" → name removed. Also any "Dear <name>," salutation. */
export function stripBuyerName(text: string): string {
  return text
    // Name runs until " for ", " on ", " regarding ", a bracket, a full stop or the line end — never into the order id.
    .replace(new RegExp(`(refund of\\s*${CUR}\\s*[\\d,.]+)\\s+to\\s+(?:(?!\\s(?:for|on|regarding)\\b)[^.\\n(]){1,80}`, 'gi'), '$1 to [buyer]')
    .replace(/^(dear|hello|hi)\s+[^,\n]{1,60},/gim, '$1 [buyer],')
    .replace(/\b(buyer|customer)\s*name\s*:\s*[^\n]+/gi, '$1 name: [buyer]')
}

export function classifyRefundNotice(from: string, subject: string): boolean {
  return from.toLowerCase().includes('donotreply@amazon') && /^refund initiated for order/i.test(subject.trim())
}

// ───────── label dictionary ─────────
type Field = 'name' | 'asin' | 'sku' | 'quantity' | 'item_refund' | 'delivery_refund' | 'reason' | 'total' | 'order' | 'ignore'
const LABELS: [RegExp, Field][] = [
  [/^(item name|product name|item title|title|item|product)$/i, 'name'],
  [/^asin$/i, 'asin'],
  [/^(seller sku|merchant sku|sku)$/i, 'sku'],
  [/^(return quantity|quantity refunded|quantity|qty)$/i, 'quantity'],
  [/^(item price refund|item refund|item price|principal( refund)?|refund amount per item)$/i, 'item_refund'],
  [/^(outbound delivery( cost)? refund|delivery( cost)? refund|shipping( cost)? refund|postage refund)$/i, 'delivery_refund'],
  [/^(refund reason|reason for refund|reason)$/i, 'reason'],
  [/^(total refund( amount)?|refund total|total refunded|total)$/i, 'total'],
  [/^(order id|order number|order)$/i, 'order'],
  [/^(refund details|item details|details|refund summary)$/i, 'ignore'],
]
const labelOf = (s: string): Field | null => { const k = s.trim().replace(/\s*:\s*$/, ''); for (const [re, f] of LABELS) if (re.test(k)) return f; return null }

/** Split "Label: value" / "Label - value" when the value is on the same line. Returns null when the line is not such a pair. */
function inlinePair(line: string): { field: Field; value: string } | null {
  const m = line.match(/^([A-Za-z][A-Za-z ]{1,40}?)\s*[:\-–]\s+(.+)$/) ?? line.match(/^([A-Za-z][A-Za-z ]{1,40}?):\s*(.+)$/)
  if (!m) return null
  const f = labelOf(m[1]); if (!f) return null
  return { field: f, value: m[2].trim() }
}

export function parseRefundInitiated(body: string, subject = ''): ParsedRefund {
  const t = stripBuyerName(norm(body))
  const orderId = subject.match(ORDER_RE)?.[1] ?? t.match(ORDER_RE)?.[1] ?? null
  const spcRef = t.match(/\b(SPC-[A-Za-z]+-\d{6,})\b/)?.[1] ?? null

  // Total from the sentence form: "We initiated a refund of GBP 359.00 to [buyer]" / "Total refund: GBP 359.00"
  let currency: string | null = null, amount: number | null = null
  const tot = t.match(new RegExp(`(?:refund of|total refund(?: amount)?:?|refund amount:?|refund total:?)\\s*${CUR}\\s*([\\d,]+(?:\\.\\d{1,2})?)`, 'i'))
  if (tot) { currency = symToCode(tot[1]); amount = money(tot[2]) }

  // ── Walk the lines: labels (inline / bare) and values, assigned in order ──
  const items: RefundItem[] = []
  const blank = (): RefundItem => ({ name: null, asin: null, sku: null, quantity: null, item_refund: null, delivery_refund: null, reason: null })
  const pending: { field: Field; item: number }[] = []   // bare labels waiting for a value, FIFO
  let cur = -1                                            // index of the item the NEXT bare label belongs to
  let total: string | null = null
  const has = (i: number, f: Field) => i >= 0 && i < items.length && (items[i] as any)[f] != null
  const set = (i: number, f: Field, v: string) => {
    if (f === 'total') { total = v; return }
    if (f === 'order' || f === 'ignore') return
    while (items.length <= i) items.push(blank())
    const it = items[i] as any
    if (f === 'quantity') it.quantity = Number(v.replace(/\D/g, '')) || null
    else if (f === 'item_refund' || f === 'delivery_refund') { const mm = v.match(MONEY_RE); it[f] = mm ? money(mm[2]) : money(v); if (!currency && mm) currency = symToCode(mm[1] ?? mm[3] ?? '') }
    else if (f === 'asin') it.asin = (v.match(/\b(B0[A-Z0-9]{8})\b/i)?.[1] ?? v).toUpperCase()
    else if (f === 'sku') it.sku = v.match(/^([A-Z0-9][A-Z0-9._\-]{2,})/i)?.[1]?.toUpperCase() ?? v
    else if (f === 'reason') it.reason = v.replace(/[.\s]+$/, '')
    else if (f === 'name') { const a = v.match(/\bASIN:?\s*(B0[A-Z0-9]{8})\b/i); if (a && !it.asin) it.asin = a[1].toUpperCase(); it.name = v.replace(/\s*ASIN.*$/i, '').trim() }
  }
  const PER_ITEM: Field[] = ['name', 'asin', 'sku', 'quantity', 'item_refund', 'delivery_refund', 'reason']
  // Which item does a bare label belong to? The current one unless that item already has this field (or a label queued
  // for it) → then it starts the next item (labels-block multi-item or alternating multi-item both work).
  const targetFor = (f: Field) => {
    if (!PER_ITEM.includes(f)) return cur
    if (cur < 0) { cur = 0; return cur }
    const queued = pending.some((p) => p.item === cur && p.field === f)
    if (has(cur, f) || queued) cur++
    return cur
  }

  for (const raw of t.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const pair = inlinePair(line)
    if (pair) { set(targetFor(pair.field), pair.field, pair.value); continue }
    const f = labelOf(line)
    if (f === 'ignore') continue                      // section heading — no value follows it
    if (f) { pending.push({ field: f, item: targetFor(f) }); continue }
    // A value line: goes to the oldest waiting label
    if (pending.length) { const p = pending.shift()!; set(p.item, p.field, line); continue }
    // Free text (intro, sign-off): a bare known reason anywhere is still worth keeping if nothing else gives one
  }

  // Drop empty shells (e.g. an "ignore" label created nothing)
  const real = items.filter((i) => i.asin || i.sku || i.item_refund != null || i.name)
  // Reason: from items, else a bare "Buyer Cancelled" / "Customer Return" anywhere in the text
  let reason = canonicalReason(real.find((i) => i.reason)?.reason ?? null)
  if (!reason) { const m = t.match(/\b(buyer cancel+ed|customer return)\b/i); reason = canonicalReason(m?.[1] ?? null) }
  for (const i of real) i.reason = canonicalReason(i.reason)
  const knownReason = !!reason && KNOWN_REASONS.includes(reason.toLowerCase())
  if (total) { const mm = total.match(MONEY_RE); if (mm) { amount = money(mm[2]); if (!currency) currency = symToCode(mm[1] ?? mm[3] ?? '') } }
  if (amount == null && real.length) amount = real.reduce((s, i) => s + (i.item_refund ?? 0) + (i.delivery_refund ?? 0), 0) || null
  if (!currency && amount != null) currency = 'GBP'

  // Excerpt: first lines that mention order / refund, already name-stripped, capped
  const excerpt = t.split('\n').map((l) => l.trim()).filter((l) => /order|refund|SPC-|ASIN|SKU|reason/i.test(l)).slice(0, 12).join('\n').slice(0, 1200)
  return { orderId, amount, currency, spcRef, items: real, reason, knownReason, excerpt }
}

function symToCode(s: string) { return s === '£' ? 'GBP' : s === '€' ? 'EUR' : s === '$' ? 'USD' : s ? s.toUpperCase() : '' }

/** Partial when the refunded item price is lower than the order's item price (unit × qty) by more than a penny. */
export function isPartialRefund(itemRefund: number | null, orderUnitPrice: number | null, quantity = 1): boolean | null {
  if (itemRefund == null || orderUnitPrice == null) return null
  return itemRefund < orderUnitPrice * Math.max(1, quantity) - 0.01
}

/** Below this a refund on a renewed iPhone cannot be the full item price — treated as partial/goodwill when the order
 *  price is unknown. Saigates' cheapest listing is well above this. */
export const PARTIAL_ABS_MAX = 100
/** Compared with the highest full refund seen for the same ASIN/SKU: under this fraction → partial. */
export const PARTIAL_RATIO = 0.6

/** Decide "partial" with whatever price evidence exists, best first:
 *  1. order unit price (SP-API)  2. highest refund seen for the same ASIN/SKU  3. absolute floor (PARTIAL_ABS_MAX). */
export function judgePartial(amount: number | null, opts: { unitPrice?: number | null; quantity?: number | null; peerMax?: number | null }): { partial: boolean | null; basis: string } {
  if (amount == null) return { partial: null, basis: 'no amount' }
  const qty = Math.max(1, opts.quantity ?? 1)
  if (opts.unitPrice != null && opts.unitPrice > 0) return { partial: amount < opts.unitPrice * qty - 0.01, basis: `order price £${opts.unitPrice.toFixed(2)} × ${qty}` }
  if (opts.peerMax != null && opts.peerMax > 0 && opts.peerMax >= PARTIAL_ABS_MAX) return { partial: amount < opts.peerMax * PARTIAL_RATIO, basis: `highest refund seen for this item £${opts.peerMax.toFixed(2)}` }
  if (amount < PARTIAL_ABS_MAX) return { partial: true, basis: `under £${PARTIAL_ABS_MAX} — cannot be a full phone refund` }
  return { partial: null, basis: 'order price unknown' }
}
