// Parsers for Amazon notification emails that are NOT customer messages:
//   - Seller Central reply copies ("Your email to <Name>")      → outbound message on the case
//   - A-to-Z Guarantee claim notices                               → amazon_events.kind = atoz_*
//   - Return authorisation notifications                           → amazon_events.kind = return_request
//   - Chargeback "Information Required" notices                    → amazon_events.kind = chargeback
// All functions are pure (string in → structured out) so they can be unit-tested on samples.

export const ORDER_RE = /\b(\d{3}-\d{7}-\d{7})\b/

export type NoticeKind = 'seller_reply_copy' | 'atoz_claim' | 'atoz_info_request' | 'atoz_decision' | 'return_request' | 'chargeback' | null

const norm = (s: string) => s.replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ')

/** Decide what an email is from its sender + subject (cheap, no body needed). */
export function classifyNotice(from: string, subject: string): NoticeKind {
  const f = from.toLowerCase(), s = subject.toLowerCase()
  if (f.includes('atoz-guarantee-no-reply@amazon')) {
    if (/information|respond within|additional/.test(s)) return 'atoz_info_request'
    if (/granted|denied|decision|closed|withdrawn|refunded|outcome/.test(s)) return 'atoz_decision'
    return 'atoz_claim'
  }
  if (f.includes('cb-seller-notification@amazon')) return 'chargeback'
  if (f.includes('donotreply@amazon')) {
    if (/^return authori[sz]ation notification/.test(s)) return 'return_request'
    if (/^your e-?mail to /.test(s)) return 'seller_reply_copy'
  }
  return null
}

// ───────── Seller Central reply copy ─────────
export function parseSellerReplyCopy(body: string, subject: string) {
  const t = norm(body)
  const orderId = t.match(ORDER_RE)?.[1] ?? null
  const m = t.match(/-{3,}\s*Begin message\s*-{3,}\s*\n([\s\S]*?)\n\s*-{3,}\s*End message\s*-{3,}/i)
  const text = (m?.[1] ?? '').replace(/\n{3,}/g, '\n\n').trim()
  const recipient = subject.match(/^your e-?mail to (.+)$/i)?.[1]?.trim() ?? null
  return { orderId, text, recipient }
}

// ───────── A-to-Z ─────────
export function parseAtoz(body: string) {
  const t = norm(body)
  const orderId = t.match(ORDER_RE)?.[1] ?? null
  const amt = t.match(/claim of\s*£\s?([\d,]+(?:\.\d{2})?)/i) ?? t.match(/£\s?([\d,]+(?:\.\d{2})?)/)
  const amount = amt ? Number(amt[1].replace(/,/g, '')) : null
  const infoRequested = /additional information is required|respond within\s*3|provide (?:the )?following information/i.test(t) && !/do not need to take any action/i.test(t)
  const deadlineDays = infoRequested ? 3 : null
  const decision = /claim (?:has been|was) (granted|denied|closed|withdrawn)/i.exec(t)?.[1]?.toLowerCase() ?? null
  return { orderId, amount, infoRequested, deadlineDays, decision, excerpt: excerpt(t, /We received an A-to-z[^\n]*|A-to-z Guarantee claim[^\n]*/i) }
}

// ───────── Return authorisation ─────────
export function parseReturnAuth(body: string) {
  const t = norm(body)
  const orderId = t.match(/Order ID:\s*(\d{3}-\d{7}-\d{7})/i)?.[1] ?? t.match(ORDER_RE)?.[1] ?? null
  const requestDate = t.match(/Return Request Date:\s*(\d{4}-\d{2}-\d{2}|[^\n]+)/i)?.[1]?.trim() ?? null
  const policyCheck = t.match(/Return Policy Check:\s*([^\n]+)/i)?.[1]?.trim() ?? null
  const authorisation = t.match(/Authori[sz]ation:\s*([^\n]+)/i)?.[1]?.trim() ?? null
  const asin = t.match(/\b(B0[A-Z0-9]{8})\b/)?.[1] ?? null

  // The item table arrives as a run of lines: product / ASIN / SKU / qty / reason / comment.
  // Find the block after "Customer’s Comment" header; values follow in order.
  let product: string | null = null, sku: string | null = null, quantity: number | null = null, reason: string | null = null, comment: string | null = null
  const hdrIdx = t.search(/Customer[’']s Comment/i)
  if (hdrIdx !== -1) {
    const after = t.slice(t.indexOf('\n', hdrIdx) + 1)
    const stop = after.search(/^\s*Using your Manage Returns page|^\s*Find the Return Request/im)
    const block = (stop !== -1 ? after.slice(0, stop) : after).split('\n').map((l) => l.trim()).filter(Boolean)
    // Expected order: [product, ASIN, SKU, qty, reason, comment…]
    const asinPos = block.findIndex((l) => /^B0[A-Z0-9]{8}$/.test(l))
    if (asinPos >= 1) {
      product = block[asinPos - 1]
      sku = block[asinPos + 1] ?? null
      quantity = Number(block[asinPos + 2]) || null
      reason = block[asinPos + 3] ?? null
      comment = block.slice(asinPos + 4).join('\n').trim() || null
    }
  }
  // Labelled variant ("Return reason: …", "Customer comments: …", "Item: …", "SKU: …", "Quantity: …")
  const lab = (re: RegExp) => t.match(re)?.[1]?.trim() || null
  reason ??= lab(/^\s*(?:Return )?reason:\s*([^\n]+)/im)
  comment ??= lab(/^\s*(?:Customer(?:[’']s)? )?comments?:\s*([^\n]+(?:\n(?![A-Z][\w ]{1,30}:)[^\n]+)*)/im)
  product ??= lab(/^\s*(?:Item|Product)(?: name)?:\s*([^\n]+)/im)
  sku ??= lab(/^\s*SKU:\s*([^\n]+)/im)
  quantity ??= Number(lab(/^\s*Quantity:\s*(\d+)/im)) || null
  const heat = /\b(hot|heat|heating|overheat|burn|smok|swell|swollen|bulg)/i.test(`${reason ?? ''} ${comment ?? ''}`)
  return { orderId, requestDate, policyCheck, authorisation, asin, product, sku, quantity, reason, comment, heat, excerpt: `Return requested (${policyCheck ?? '—'}, ${authorisation ?? '—'}). Reason: ${reason ?? '—'}` }
}

// ───────── Chargeback ─────────
export type Chargeback = ReturnType<typeof parseChargeback>
export function parseChargeback(body: string) {
  const t = norm(body)
  const orderId = t.match(/Order number:\s*(\d{3}-\d{7}-\d{7})/i)?.[1] ?? t.match(ORDER_RE)?.[1] ?? null
  // "Order date: 09/21/2026, 07:17" (US m/d/y as in sample) — also accept d/m/y if first field > 12
  let orderDate: Date | null = null
  const od = t.match(/Order date:\s*(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s*(\d{1,2}):(\d{2})/i)
  if (od) {
    let [, a, b, y, hh, mm] = od
    let month = Number(a), day = Number(b)
    if (month > 12) [month, day] = [day, month]
    orderDate = new Date(Date.UTC(Number(y), month - 1, day, Number(hh), Number(mm)))
  }
  // Labelled date fallback: "Order date: 02 September 2026"
  if (!orderDate) {
    const od2 = t.match(/Order date:\s*([^\n]+)/i)?.[1]
    const d2 = od2 ? new Date(od2.trim()) : null
    if (d2 && !isNaN(d2.getTime())) orderDate = d2
  }
  const items = t.match(/Items purchased:\s*([^\n]+)/i)?.[1]?.trim() ?? null
  const amtM = items?.match(/for\s*([\d,]+(?:\.\d+)?)\s*(GBP|EUR|USD|£)/i) ?? t.match(/(?:Amount|Chargeback amount|Disputed amount):\s*(?:(£|GBP|EUR|USD)\s?)?([\d,]+(?:\.\d+)?)\s*(GBP|EUR|USD)?/i)?.slice(0) as RegExpMatchArray | null
  let amount: number | null = null, currency = 'GBP'
  if (amtM) {
    if (amtM.length === 3) { amount = Number(amtM[1].replace(/,/g, '')); currency = amtM[2] === '£' ? 'GBP' : amtM[2].toUpperCase() }
    else { amount = Number(amtM[2].replace(/,/g, '')); const cur = amtM[1] ?? amtM[3] ?? '£'; currency = cur === '£' ? 'GBP' : cur.toUpperCase() }
  }
  const itemDescription =
    items?.replace(/\s*for\s*[\d,.]+\s*(GBP|EUR|USD|£).*$/i, '').replace(/^\d+\s*of\s*/i, '').replace(/^\(|\)$/g, '').trim() ??
    t.match(/Item description:\s*([^\n]+)/i)?.[1]?.trim() ??
    null

  // PII block: everything between "Shipping address:" and the blank line / "In response to this email"
  const ship = t.match(/Shipping address:\s*\n([\s\S]*?)(?:\n\s*\n|\n\s*In response to this email)/i)
  const shippingLines = ship ? ship[1].split('\n').map((l) => l.trim()).filter(Boolean) : []
  const customerName = shippingLines[0] ?? null
  const customerAddress = shippingLines.slice(1).join(', ') || null

  // Checklist Amazon asks for
  const checklist = [...t.matchAll(/^\s*(?:--|-|•)\s*(.+)$/gm)].map((m) => m[1].trim())

  return { orderId, orderDate, items, amount, currency, itemDescription, customerName, customerAddress, shippingBlock: ship?.[0] ?? null, checklist, deadlineDays: 7 }
}

/** Remove the chargeback shipping block (and its individual lines) from any text. */
export function redactChargebackPii(text: string, cb: { customerName: string | null; customerAddress: string | null; shippingBlock: string | null }) {
  let out = text
  if (cb.shippingBlock) out = out.replace(cb.shippingBlock, 'Shipping address: [redacted]\n')
  for (const v of [cb.customerName, ...(cb.customerAddress?.split(',') ?? [])].map((x) => x?.trim()).filter((x): x is string => !!x && x.length > 2)) {
    out = out.replace(new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[redacted]')
  }
  return out
}

function excerpt(t: string, re: RegExp) {
  return (t.match(re)?.[0] ?? t.split('\n').find((l) => l.trim().length > 20) ?? '').trim().slice(0, 300)
}
