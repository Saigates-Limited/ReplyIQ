// Carrier registry: who we email, how fast they must answer, what their tracking numbers look like,
// and how to find their emails in Gmail. Addresses can be overridden in Settings → Carrier desk (app_settings).

export type CarrierId = 'royal_mail' | 'dpd' | 'fedex' | 'evri' | 'other'

export type CarrierInfo = {
  id: CarrierId
  label: string
  short: string // used in subjects and next actions ("RM", "DPD")
  /** Where investigation emails go by default (editable in Settings). null = staff must type it. */
  investigationTo: string | null
  /** Working days the carrier's customer service has to reply to an email. */
  replyDays: number
  /** Working days for a decision on a submitted claim. */
  claimDecisionDays: number
  /** Where formal claims are lodged (shown in next actions; a claim pack is pasted there). */
  claimRoute: string
  /** Gmail search terms for this carrier's mail (combined with a lookback window). */
  gmailQuery: string
}

export const CARRIERS: Record<CarrierId, CarrierInfo> = {
  royal_mail: {
    id: 'royal_mail', label: 'Royal Mail', short: 'RM',
    investigationTo: 'business.customer.service@royalmail.com',
    replyDays: 3, claimDecisionDays: 10,
    claimRoute: 'royalmail.com/claims (business claims portal)',
    gmailQuery: '(from:royalmail.com OR to:royalmail.com)',
  },
  dpd: {
    id: 'dpd', label: 'DPD', short: 'DPD',
    investigationTo: 'platinumsupport@dpd.co.uk',
    replyDays: 5, claimDecisionDays: 10,
    claimRoute: 'the DPD claims form (claims.dpdgroup.co.uk)',
    gmailQuery: '(from:dpd.co.uk OR from:dpd.uk OR from:dpdgroup.co.uk OR to:dpd.co.uk OR to:dpd.uk OR to:dpdgroup.co.uk OR from:unit4cloud.com)',
  },
  fedex: {
    id: 'fedex', label: 'FedEx', short: 'FedEx',
    investigationTo: null,
    replyDays: 5, claimDecisionDays: 10,
    claimRoute: 'the FedEx online claims centre',
    gmailQuery: '((from:fedex.com OR to:fedex.com) (claim OR investigation OR lost OR damaged OR missing OR "proof of delivery") -subject:(customs OR clearance OR "pre-alert" OR MRN OR rate))',
  },
  evri: {
    id: 'evri', label: 'Evri', short: 'Evri',
    investigationTo: null,
    replyDays: 5, claimDecisionDays: 10,
    claimRoute: 'the Evri business claims form',
    gmailQuery: '(from:evri.com OR to:evri.com)',
  },
  other: {
    id: 'other', label: 'Other carrier', short: 'Carrier',
    investigationTo: null, replyDays: 5, claimDecisionDays: 10, claimRoute: "the carrier's claims process", gmailQuery: '',
  },
}

/** Free-text carrier name (case field, SP-API "carrier") → registry id. */
export function normaliseCarrier(v: string | null | undefined): CarrierId | null {
  const s = String(v ?? '').toLowerCase()
  if (!s.trim()) return null
  if (/royal\s*mail|parcelforce|\brm\b/.test(s)) return 'royal_mail'
  if (/\bdpd\b/.test(s)) return 'dpd'
  if (/fed\s*ex/.test(s)) return 'fedex'
  if (/evri|hermes/.test(s)) return 'evri'
  return 'other'
}

/** Carrier from the sender/recipient address of an email. */
export function carrierFromAddress(addr: string): CarrierId | null {
  const a = addr.toLowerCase()
  if (/@([\w-]+\.)*royalmail\.com\b/.test(a)) return 'royal_mail'
  if (/@([\w-]+\.)*(dpd\.co\.uk|dpd\.uk|dpdgroup\.co\.uk|unit4cloud\.com)\b/.test(a)) return 'dpd'
  if (/@([\w-]+\.)*fedex\.com\b/.test(a)) return 'fedex'
  if (/@([\w-]+\.)*evri\.com\b/.test(a)) return 'evri'
  return null
}

const RM_RE = /\b([A-Z]{2}\s?\d{3}\s?\d{3}\s?\d{3}\s?GB)\b/g
const DPD_RE = /\b(15\d{2}\s?\d{4}\s?\d{3}\s?\d{3}|15\d{12})\b/g // DPD UK parcel numbers: 14 digits, written with or without spaces
const FEDEX_RE = /\b(\d{12})\b/g

export const normaliseTracking = (t: string) => t.replace(/\s+/g, '').toUpperCase()

/** Tracking numbers found in text. FedEx 12-digit numbers only count when the text is about FedEx. */
export function findTrackings(text: string, hint: CarrierId | null = null): { carrier: CarrierId; tracking: string }[] {
  const out = new Map<string, { carrier: CarrierId; tracking: string }>()
  const t = text.replace(/\b\d{3}-\d{7}-\d{7}\b/g, ' ') // Amazon order ids are not tracking numbers
  for (const m of t.toUpperCase().matchAll(RM_RE)) out.set(`royal_mail:${normaliseTracking(m[1])}`, { carrier: 'royal_mail', tracking: normaliseTracking(m[1]) })
  for (const m of t.matchAll(DPD_RE)) out.set(`dpd:${normaliseTracking(m[1])}`, { carrier: 'dpd', tracking: normaliseTracking(m[1]) })
  if (hint === 'fedex' || /fedex/i.test(text)) for (const m of t.matchAll(FEDEX_RE)) out.set(`fedex:${m[1]}`, { carrier: 'fedex', tracking: m[1] })
  return [...out.values()]
}

/** Tracking number → carrier, when the format is unambiguous. */
export function carrierOfTracking(tracking: string): CarrierId | null {
  const t = normaliseTracking(tracking)
  if (/^[A-Z]{2}\d{9}GB$/.test(t)) return 'royal_mail'
  if (/^15\d{12}$/.test(t)) return 'dpd'
  if (/^\d{12}$/.test(t)) return 'fedex'
  return null
}

/** doc id used by the old Carrier Claims Desk dashboard: "RM-JT902503606GB", "DPD-15503235785485" */
export function legacyKey(carrier: CarrierId, tracking: string) {
  return `${carrier === 'royal_mail' ? 'RM' : carrier === 'dpd' ? 'DPD' : carrier === 'fedex' ? 'FDX' : carrier.toUpperCase()}-${tracking}`
}
