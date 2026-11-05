// Parser for Amazon "Refund Initiated for Order <id>" emails (sender donotreply@amazon.com).
// Pure: text in → structured out. The buyer's name is stripped and never stored.
// Written against the facts of two real emails (4 Nov 2026); re-check against the raw text when a real
// forward arrives (see tests/returns.test.ts).

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

const norm = (s: string) => s.replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n')
const money = (s: string | undefined | null) => (s == null ? null : Number(String(s).replace(/[,£$]/g, '')))
const CUR = '(GBP|EUR|USD|£|€|\\$)'

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

export function parseRefundInitiated(body: string, subject = ''): ParsedRefund {
  const t = stripBuyerName(norm(body))
  const orderId = subject.match(ORDER_RE)?.[1] ?? t.match(ORDER_RE)?.[1] ?? null

  // Total: "We initiated a refund of GBP 359.00 to [buyer]" / "Total refund: GBP 359.00" / "Refund amount: £359.00"
  let currency: string | null = null, amount: number | null = null
  const tot = t.match(new RegExp(`(?:refund of|total refund(?: amount)?:?|refund amount:?|refund total:?)\\s*${CUR}\\s*([\\d,]+(?:\\.\\d{1,2})?)`, 'i'))
  if (tot) { currency = symToCode(tot[1]); amount = money(tot[2]) }

  const spcRef = t.match(/\b(SPC-[A-Za-z]+-\d{6,})\b/)?.[1] ?? null

  // Items: look for repeating blocks. Tolerant of "Label: value" lines in any order within a block.
  const items: RefundItem[] = []
  const asinRe = /\bASIN:?\s*(B0[A-Z0-9]{8})\b/gi
  // Split into blocks at each ASIN occurrence; attribute nearby labelled lines to that block.
  const asinPositions: { asin: string; idx: number }[] = []
  for (let m = asinRe.exec(t); m; m = asinRe.exec(t)) asinPositions.push({ asin: m[1], idx: m.index })
  const blocks: string[] = []
  if (asinPositions.length) {
    for (let i = 0; i < asinPositions.length; i++) {
      const start = Math.max(0, asinPositions[i].idx - 400)
      const end = i + 1 < asinPositions.length ? asinPositions[i + 1].idx - 400 : Math.min(t.length, asinPositions[i].idx + 700)
      blocks.push(t.slice(start, Math.max(end, asinPositions[i].idx + 10)))
    }
  } else blocks.push(t)

  for (const b of blocks) {
    const asin = b.match(/\bASIN:?\s*(B0[A-Z0-9]{8})\b/i)?.[1] ?? null
    const sku = b.match(/\b(?:SKU|Seller SKU|Merchant SKU):?\s*([A-Z0-9][A-Z0-9._\-]{2,})/i)?.[1] ?? null
    const qty = b.match(/\b(?:Return quantity|Quantity|Qty):?\s*(\d+)/i)?.[1]
    const itemRefund = b.match(new RegExp(`\\b(?:Item price refund|Item refund|Item price|Principal(?: refund)?):?\\s*${CUR}?\\s*([\\d,]+(?:\\.\\d{1,2})?)`, 'i'))
    const delivRefund = b.match(new RegExp(`\\b(?:Outbound delivery(?: cost)? refund|Delivery(?: cost)? refund|Shipping refund|Postage refund):?\\s*${CUR}?\\s*([\\d,]+(?:\\.\\d{1,2})?)`, 'i'))
    const reason = b.match(/\b(?:Refund reason|Reason)(?: for refund)?:?\s*([^\n]{2,60})/i)?.[1]?.trim() ?? null
    const name = b.match(/\b(?:Item name|Item|Product|Title):?\s*([^\n]{3,160})/i)?.[1]?.trim().replace(/\s*ASIN.*$/i, '') ?? null
    if (!asin && !sku && !itemRefund) continue
    if (itemRefund?.[1] && !currency) currency = symToCode(itemRefund[1])
    items.push({ name, asin, sku, quantity: qty ? Number(qty) : null, item_refund: money(itemRefund?.[2]), delivery_refund: delivRefund ? money(delivRefund[2]) : null, reason })
  }

  // Overall reason: from items, else anywhere in the body
  const reason = items.find((i) => i.reason)?.reason ?? t.match(/\b(?:Refund reason|Reason)(?: for refund)?:?\s*([^\n]{2,60})/i)?.[1]?.trim() ?? null
  const knownReason = !!reason && KNOWN_REASONS.includes(reason.toLowerCase().replace(/[.\s]+$/, ''))
  if (amount == null && items.length) amount = items.reduce((s, i) => s + (i.item_refund ?? 0) + (i.delivery_refund ?? 0), 0) || null

  // Excerpt: first lines that mention order / refund, already name-stripped, capped
  const excerpt = t.split('\n').map((l) => l.trim()).filter((l) => /order|refund|SPC-|ASIN|SKU|reason/i.test(l)).slice(0, 12).join('\n').slice(0, 1200)
  return { orderId, amount, currency, spcRef, items, reason, knownReason, excerpt }
}

function symToCode(s: string) { return s === '£' ? 'GBP' : s === '€' ? 'EUR' : s === '$' ? 'USD' : s.toUpperCase() }

/** Partial when the refunded item price is lower than the order's item price (unit × qty) by more than a penny. */
export function isPartialRefund(itemRefund: number | null, orderUnitPrice: number | null, quantity = 1): boolean | null {
  if (itemRefund == null || orderUnitPrice == null) return null
  return itemRefund + 0.01 < orderUnitPrice * Math.max(1, quantity)
}
