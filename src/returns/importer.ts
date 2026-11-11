// One-time import from the Google Sheet "Returns" export. Pure clean-up functions + CSV parsing; the API does the DB work.
// Nothing here guesses: anything ambiguous goes to the review list with the original value kept.
import { parseImeiCell } from './imei'
import type { Cable, Outcome, Reason } from './rules'

export type SheetRow = Record<string, string>

export type ReviewItem = { row: number; order_id: string | null; field: string; value: string; reason: string }

export type CleanRow = {
  row: number
  order_id: string | null
  order_date: string | null      // YYYY-MM-DD
  return_date: string | null     // YYYY-MM-DD (Date of Return → received_at)
  marketplace: string | null
  customer_name: string | null
  sku_raw: string | null
  sku: string | null             // canonical, only when matched
  model: string | null           // item details text (kept as product label)
  reason: Reason | null
  cable: Cable | null
  outcome: Outcome | null
  frp: boolean | null
  notes: string | null
  imei: string | null            // first IMEI (kept for existing callers)
  imeis: string[]                // every phone on this return: 0, 1 or 2 (a 30-digit cell splits into two)
  serial: string | null          // serial-number-looking value from the IMEI column (also copied into notes)
  imei_kind: 'none' | 'imei' | 'split' | 'serial' | 'review'
  non_amazon: boolean            // order id is not in Amazon format (PO-… or another marketplace)
  supplier_code: string | null
  cms_ticket: string | null
  compensation_ref: string | null
  replacement_sent_on: string | null
  review: ReviewItem[]
}

// ───────── CSV ─────────
/** RFC-4180-ish CSV parser (quotes, embedded commas/newlines). Returns rows as objects keyed by the header. */
export function parseCsv(text: string): SheetRow[] {
  const rows: string[][] = []
  let cur: string[] = [], field = '', q = false
  const src = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (q) {
      if (ch === '"') { if (src[i + 1] === '"') { field += '"'; i++ } else q = false }
      else field += ch
    } else if (ch === '"') q = true
    else if (ch === ',') { cur.push(field); field = '' }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && src[i + 1] === '\n') i++; cur.push(field); rows.push(cur); cur = []; field = '' }
    else field += ch
  }
  if (field.length || cur.length) { cur.push(field); rows.push(cur) }
  const header = (rows.shift() ?? []).map((h) => h.trim())
  return rows.filter((r) => r.some((v) => v.trim() !== '')).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])))
}

/** Find a column by loose name (case/space-insensitive, several aliases). */
export function col(row: SheetRow, ...names: string[]): string {
  const keys = Object.keys(row)
  for (const n of names) {
    const k = keys.find((k) => k.replace(/[\s_./]+/g, '').toLowerCase() === n.replace(/[\s_./]+/g, '').toLowerCase())
    if (k !== undefined) return row[k] ?? ''
  }
  return ''
}

// ───────── field clean-up ─────────
const ORDER_RE = /\b(\d{3}-\d{7}-\d{7})\b/
const PO_RE = /\b(PO-\d{3}-\d{8,20})\b/i

/** Amazon order id, or a non-Amazon one (PO-… number, or any reference when the Marketplace column names another marketplace). */
export function parseOrderId(orderRaw: string, marketplace: string): { order_id: string | null; non_amazon: boolean } {
  const amazon = orderRaw.match(ORDER_RE)?.[1]
  if (amazon) return { order_id: amazon, non_amazon: false }
  const po = orderRaw.match(PO_RE)?.[1]
  if (po) return { order_id: po.toUpperCase(), non_amazon: true }
  const ref = orderRaw.trim().replace(/\s+/g, ' ')
  if (ref.length >= 4 && ref.length <= 64 && /[A-Za-z0-9]{4}/.test(ref) && marketplace.trim() && !/amazon/i.test(marketplace)) return { order_id: ref, non_amazon: true }
  return { order_id: null, non_amazon: false }
}

/** "DD/MM/YYYY", "D/M/YY", "YYYY-MM-DD", "6 Jan 2026" → YYYY-MM-DD or null. UK day-first. */
export function parseUkDate(v: string | null | undefined): string | null {
  const s = String(v ?? '').trim()
  if (!s) return null
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/)
  if (m) { const y = m[3].length === 2 ? `20${m[3]}` : m[3]; const d = Number(m[1]), mo = Number(m[2]); if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` }
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\.?\s+(\d{4})/)
  if (m) { const mo = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ').indexOf(m[2].slice(0, 3).toLowerCase()) + 1; if (mo) return `${m[3]}-${String(mo).padStart(2, '0')}-${m[1].padStart(2, '0')}` }
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10)
}

export const SKU_SUFFIX_RE = /-(AMAZON|AMAZ|AAMZ|AMZ)\d*$/i

/** Strip leading ": " and spaces, drop marketplace suffixes. Returns the candidate (not yet matched). */
export function normaliseSku(raw: string | null | undefined): string | null {
  let s = String(raw ?? '').trim().replace(/^[:\s]+/, '').trim()
  if (!s) return null
  s = s.split(/\s+/)[0] // "I13-128-MDT-A-AMZ iPhone 13 …" → first token
  s = s.replace(SKU_SUFFIX_RE, '')
  return s.toUpperCase()
}

/** Match a normalised candidate against the known SKU list. Exact only — no guessing. */
export function matchSku(candidate: string | null, known: Set<string>): string | null {
  if (!candidate) return null
  if (known.has(candidate)) return candidate
  // Known list may hold marketplace variants too; strip them for comparison
  for (const k of known) if (k.replace(SKU_SUFFIX_RE, '').toUpperCase() === candidate) return k
  return null
}

export function mapCable(v: string): Cable | null {
  const s = v.trim().toLowerCase()
  if (!s) return null
  if (/^(n-?cable|no cable|none|no)$/.test(s)) return 'not_returned'
  if (/burn|damag/.test(s)) return 'damaged'
  if (/^rts$|n\/?a|not applicable/.test(s)) return 'not_applicable'
  if (/^cable$|^yes$|returned/.test(s)) return 'returned'
  return null
}

export function mapReason(v: string): Reason | null {
  const s = v.trim().toLowerCase()
  if (!s) return null
  if (/^(esthetic|aesthetic|cosmetic)/.test(s)) return 'cosmetic'
  if (/^(com|change of mind|changed mind|unwanted)/.test(s)) return 'change_of_mind'
  if (/^rts|return(ed)? to sender/.test(s)) return 'returned_to_sender'
  if (/wrong item|wrong/.test(s)) return 'wrong_item'
  if (/fault|defect|broken|not working|dead/.test(s)) return 'faulty'
  return null
}

export function mapOutcome(v: string): Outcome | null {
  const s = v.trim().toLowerCase()
  if (!s) return null
  if (/^(replace|replacement|rpl)/.test(s)) return 'replacement'
  if (/^resend|re-send|re sent|resent/.test(s)) return 'resend'
  if (/partial/.test(s)) return 'partial_refund'
  if (/^refund|full refund|refunded/.test(s)) return 'refund'
  if (/^repair/.test(s)) return 'repair'
  return null
}

export function mapFrp(v: string): boolean | null {
  const s = v.trim().toLowerCase()
  if (!s) return null
  if (/^(yes|y|true|locked|frp|icloud)/.test(s)) return true
  if (/^(no|n|false|unlocked|none)/.test(s)) return false
  return null
}

/** "RPL SENT 06/01/2026" / "replacement sent 6/1/26" → YYYY-MM-DD */
export function dateFromNotes(notes: string | null | undefined): string | null {
  const s = String(notes ?? '')
  const m = s.match(/\b(?:rpl|replacement|resen[dt]|sent)\b[^0-9]{0,20}(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})/i)
  return m ? parseUkDate(m[1]) : null
}

const SUPPLIER_RE = /^[A-Z]{2,4}\d{3}$/
const CMS_RE = /^\d{6,}$|^[A-Z]{2,}-?\d{5,}$/i

/** Clean one sheet row. `knownSkus` / `knownSuppliers` are the drop-down lists. */
export function cleanRow(row: SheetRow, idx: number, knownSkus: Set<string>, knownSuppliers: Set<string>): CleanRow {
  const review: ReviewItem[] = []
  const orderRaw = col(row, 'Order ID', 'OrderID', 'Order')
  const marketplaceRaw = col(row, 'Marketplace')
  const { order_id, non_amazon } = parseOrderId(orderRaw, marketplaceRaw)
  if (!order_id) review.push({ row: idx, order_id: null, field: 'Order ID', value: orderRaw, reason: 'no usable order ID (needs Amazon format, a PO-… number, or a non-Amazon Marketplace)' })
  const flag = (field: string, value: string, reason: string) => review.push({ row: idx, order_id, field, value, reason })

  const order_date = parseUkDate(col(row, 'Order Date'))
  if (col(row, 'Order Date') && !order_date) flag('Order Date', col(row, 'Order Date'), 'unreadable date')
  const return_date = parseUkDate(col(row, 'Date of Return', 'Return Date'))
  if (col(row, 'Date of Return', 'Return Date') && !return_date) flag('Date of Return', col(row, 'Date of Return', 'Return Date'), 'unreadable date')

  const itemRaw = col(row, 'Item details', 'Item', 'SKU')
  const skuCandidate = normaliseSku(itemRaw)
  const sku = matchSku(skuCandidate, knownSkus)
  if (itemRaw && !sku) flag('Item details', itemRaw, `SKU "${skuCandidate ?? ''}" not in the SKU list — pick the right one`)

  const reasonRaw = col(row, 'Reason'); const reason = mapReason(reasonRaw)
  if (reasonRaw && !reason) flag('Reason', reasonRaw, 'unknown reason — choose a category')
  const cableRaw = col(row, 'cable', 'Cable'); const cable = mapCable(cableRaw)
  if (cableRaw && !cable) flag('cable', cableRaw, 'unknown cable value')
  const solRaw = col(row, 'Solution agreed', 'Solution'); const outcome = mapOutcome(solRaw)
  if (solRaw && !outcome) flag('Solution agreed', solRaw, 'unknown outcome')
  const frpRaw = col(row, 'FRP'); const frp = mapFrp(frpRaw)
  if (frpRaw && frp === null) flag('FRP', frpRaw, 'not yes/no')

  let notes = col(row, 'Notes') || null
  const extraNotes: string[] = []

  const imeiRaw = col(row, 'IMEI NO', 'IMEI', 'IMEI No')
  let imeis: string[] = [], serial: string | null = null
  let imei_kind: CleanRow['imei_kind'] = 'none'
  const cell = parseImeiCell(imeiRaw)
  if (cell.kind === 'none') extraNotes.push('no IMEI (legacy)')   // normal for old register rows: imports as usual, not on the review list
  else if (cell.kind === 'imei') {
    imeis = cell.imeis; imei_kind = cell.split ? 'split' : 'imei'
    if (cell.split) extraNotes.push(cell.duplicate ? 'IMEI cell held the same IMEI twice: imported once' : `IMEI cell held two IMEIs (${cell.imeis.join(', ')}): imported as 2 phones on this return`)
    if (cell.duplicate) flag('IMEI NO', imeiRaw, 'same IMEI entered twice — imported once')
  } else if (cell.kind === 'serial') { serial = cell.serial; imei_kind = 'serial'; extraNotes.push(`Serial: ${cell.serial} (no IMEI)`) }
  else { imei_kind = 'review'; flag('IMEI NO', imeiRaw, `IMEI ${cell.reason}`) }
  const imei = imeis[0] ?? null

  const supRaw = col(row, 'SUPPLIER CODE', 'Supplier code', 'Supplier').toUpperCase().trim()
  let supplier_code: string | null = null
  if (supRaw) {
    if (knownSuppliers.has(supRaw)) supplier_code = supRaw
    else if (SUPPLIER_RE.test(supRaw)) flag('SUPPLIER CODE', supRaw, 'supplier code not in the list — a manager can add it')
    else { extraNotes.push(`Supplier code column said: ${supRaw}`); flag('SUPPLIER CODE', supRaw, 'not a supplier code — moved to Notes') }
  }

  const cmsRaw = col(row, 'CMS REFUND TICKET NUMBER', 'CMS ticket', 'CMS').trim()
  let cms_ticket: string | null = null
  if (cmsRaw) {
    if (CMS_RE.test(cmsRaw)) cms_ticket = cmsRaw
    else { extraNotes.push(`CMS ticket column said: ${cmsRaw}`); flag('CMS REFUND TICKET NUMBER', cmsRaw, 'does not look like a ticket number — moved to Notes') }
  }
  const compensation_ref = col(row, 'COMPENSATION NUMBER/INVOICE', 'Compensation', 'Invoice').trim() || null

  const replacement_sent_on = dateFromNotes(notes)
  if (extraNotes.length) notes = [notes, ...extraNotes].filter(Boolean).join(' | ')

  return {
    row: idx, order_id, order_date, return_date,
    marketplace: marketplaceRaw.trim() || (non_amazon ? 'Non-Amazon' : null),
    customer_name: col(row, 'Customer Name', 'Customer') || null,
    sku_raw: itemRaw || null, sku, model: itemRaw ? itemRaw.replace(/^[:\s]+/, '').trim() : null,
    reason, cable, outcome, frp, notes, imei, imeis, serial, imei_kind, non_amazon, supplier_code, cms_ticket, compensation_ref, replacement_sent_on, review,
  }
}
