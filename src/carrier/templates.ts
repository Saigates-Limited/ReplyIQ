// Carrier emails are built from templates, not by the AI. Carriers need the recipient's name and delivery address,
// which ReplyIQ never sends to OpenAI, so filling them server-side keeps that rule intact and costs nothing.
// Every template returns `missing` (facts it could not fill) so staff can see what to add before approving.
import { CARRIERS, type CarrierId } from './carriers'
import type { CarrierIssue } from './detect'

export type DraftKind = 'investigation' | 'chase' | 'challenge' | 'info_reply' | 'claim_pack' | 'postage_refund'

export type Facts = {
  carrier: CarrierId
  tracking: string | null
  orderId: string | null
  issue: CarrierIssue
  product: string | null
  service: string | null
  value: number | null
  postedOn: string | null // YYYY-MM-DD
  deliveredOn: string | null // what tracking says
  lastScan: string | null // free text, e.g. "26 Sep, Bristol Mail Centre"
  recipientName: string | null // first + last name: goes to the CARRIER only, never to the AI
  recipientAddress: string | null
  carrierRefs: string[]
  claimRef: string | null
  raisedAt: string | null // ISO
  lastUsAt: string | null
  workingDaysWaiting: number | null
  carrierAsked: string | null // summary of what the carrier asked for (info_reply)
  claimed: number | null
  staffName: string
  signature: string // company block under the staff name
}

export type Composed = { to: string | null; subject: string; body: string; missing: string[]; needsManager: boolean }

const fmtDate = (ymd: string | null) => {
  if (!ymd) return null
  const d = new Date(`${ymd.slice(0, 10)}T12:00:00Z`)
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
}
const money = (n: number | null) => (n == null ? null : `£${Number(n).toFixed(2)}`)
const bullets = (rows: [string, string | null][]) => rows.filter(([, v]) => v).map(([k, v]) => `* ${k}: ${v}`).join('\n')
const latestRef = (f: Facts) => f.carrierRefs[f.carrierRefs.length - 1] ?? null
const refPart = (f: Facts) => (latestRef(f) ? ` – Case Reference #${latestRef(f)}` : '')

function signOff(f: Facts) {
  return `Kind regards,\n\n${f.staffName}\n${f.signature}`.trim()
}

function detailsBlock(f: Facts) {
  return bullets([
    ['Tracking number', f.tracking],
    ['Service', f.service],
    ['Date posted', fmtDate(f.postedOn)],
    ['Order reference', f.orderId],
    ['Contents', f.product],
    ['Value', money(f.value)],
    ['Recipient', f.recipientName],
    ['Delivery address', f.recipientAddress],
    ['Tracking shows', f.deliveredOn ? `delivered on ${fmtDate(f.deliveredOn)}` : f.lastScan ? `last scan ${f.lastScan}` : null],
    ['Your case reference(s)', f.carrierRefs.length ? f.carrierRefs.join(', ') : null],
  ])
}

function missingFor(f: Facts, kind: DraftKind): string[] {
  const m: string[] = []
  if (!f.tracking) m.push('tracking number')
  if (kind === 'investigation' || kind === 'claim_pack') {
    if (!f.postedOn) m.push('date posted')
    if (!f.product) m.push('contents (product)')
  }
  if (kind === 'claim_pack' && f.value == null) m.push('value')
  if ((f.issue === 'delivered_not_received' || f.issue === 'pod_request') && !f.recipientAddress && kind === 'investigation') m.push('delivery address (recommended: lets the carrier compare the GPS scan)')
  if (kind === 'chase' && !latestRef(f)) m.push('carrier case reference')
  if (kind === 'info_reply') m.push('the information the carrier asked for')
  if (kind === 'challenge') m.push('what the proof-of-delivery photo shows / why it is wrong')
  return m
}

const INTRO: Record<CarrierIssue, (f: Facts) => { subject: string; ask: string }> = {
  lost: (f) => ({
    subject: `URGENT: No tracking update${f.lastScan ? ` since ${f.lastScan.split(',')[0]}` : ''} – ${f.tracking} – Order ${f.orderId ?? ''}`.trim(),
    ask: `We are contacting you about tracking number ${f.tracking}${f.postedOn ? `, posted on ${fmtDate(f.postedOn)}` : ''}. The item has not been delivered and the tracking has not updated${f.lastScan ? ` since ${f.lastScan}` : ''}.\n\nPlease urgently locate the item and let us know where it is. If it cannot be traced, please confirm that it is classed as lost so that we can submit a claim.`,
  }),
  delivered_not_received: (f) => ({
    subject: `Urgent delivery investigation – marked delivered but not received – ${f.tracking}${f.orderId ? ` (${f.orderId})` : ''}`,
    ask: `We are contacting you about tracking number ${f.tracking}, which is shown as delivered${f.deliveredOn ? ` on ${fmtDate(f.deliveredOn)}` : ''}. Our customer has confirmed that they have not received the parcel.\n\nPlease investigate and confirm exactly where it was delivered (to the recipient, a neighbour, a safe place or another address), and send us the proof-of-delivery image, signature and GPS location of the delivery scan.`,
  }),
  empty_parcel: (f) => ({
    subject: `Contents missing – empty parcel delivered – ${f.tracking}${f.orderId ? ` (${f.orderId})` : ''}`,
    ask: `We are contacting you about tracking number ${f.tracking}. Our customer received the packaging, but the contents${f.product ? ` (${f.product})` : ''} were missing.\n\nPlease investigate the handling of this item, including any weight recorded at acceptance and at delivery, and send us the proof-of-delivery image. Please also confirm the next step for a claim for the missing contents.`,
  }),
  damaged: (f) => ({
    subject: `Item damaged in transit – ${f.tracking}${f.orderId ? ` (${f.orderId})` : ''}`,
    ask: `We are contacting you about tracking number ${f.tracking}. The item arrived with the packaging and contents damaged. Please log this and confirm what you need from us to process a damage claim.`,
  }),
  wrong_item: (f) => ({
    subject: `Delivery query – ${f.tracking}${f.orderId ? ` (${f.orderId})` : ''}`,
    ask: `We are contacting you about tracking number ${f.tracking}. Please investigate the delivery of this item.`,
  }),
  pod_request: (f) => ({
    subject: `Proof of delivery request – ${f.tracking}${f.orderId ? ` (${f.orderId})` : ''}`,
    ask: `Please send us the proof of delivery for tracking number ${f.tracking}, including the delivery photo, signature and GPS location of the delivery scan.`,
  }),
  return_to_sender: (f) => ({
    subject: `Return to sender – please locate – ${f.tracking}${f.orderId ? ` (${f.orderId})` : ''}`,
    ask: `Tracking number ${f.tracking} is being returned to us as sender. Please confirm where the item is now and when it will reach us.`,
  }),
  postage_refund: (f) => ({
    subject: `Postage refund request – late delivery – ${f.tracking}`,
    ask: `Tracking number ${f.tracking}${f.service ? ` (${f.service})` : ''} was not delivered within the guaranteed time. Please refund the postage paid for this item.`,
  }),
  other: (f) => ({ subject: `Delivery investigation – ${f.tracking}${f.orderId ? ` (${f.orderId})` : ''}`, ask: `Please investigate the delivery of tracking number ${f.tracking}.` }),
}

const greeting = (c: CarrierId) => (c === 'royal_mail' ? 'Dear Royal Mail Customer Services,' : c === 'dpd' ? 'Dear DPD Support Team,' : `Dear ${CARRIERS[c].label} Customer Services,`)

export function compose(kind: DraftKind, f: Facts, toOverride?: string | null): Composed {
  const carrier = CARRIERS[f.carrier]
  const to = toOverride ?? carrier.investigationTo
  const missing = missingFor(f, kind)
  if (!to && kind !== 'claim_pack') missing.unshift(`${carrier.label} email address (set it in Settings → Carrier desk)`)
  const g = greeting(f.carrier)

  if (kind === 'investigation' || kind === 'postage_refund') {
    const intro = INTRO[kind === 'postage_refund' ? 'postage_refund' : f.issue](f)
    const body = `${g}\n\n${intro.ask}\n\nDetails:\n${detailsBlock(f)}\n\nWe would be grateful for an update as soon as possible.\n\n${signOff(f)}`
    return { to, subject: intro.subject, body, missing, needsManager: false }
  }

  if (kind === 'chase') {
    const since = f.lastUsAt ? fmtDate(f.lastUsAt.slice(0, 10)) : f.raisedAt ? fmtDate(f.raisedAt.slice(0, 10)) : null
    const subject = `Follow-up – no reply${f.workingDaysWaiting ? ` after ${f.workingDaysWaiting} working days` : ''} – ${f.tracking}${refPart(f)}`
    const body = `${g}\n\nWe contacted you${since ? ` on ${since}` : ''} about tracking number ${f.tracking}${latestRef(f) ? ` (your case reference ${latestRef(f)})` : ''} and have not yet received a reply${f.workingDaysWaiting ? ` after ${f.workingDaysWaiting} working days` : ''}.\n\nPlease update us today on the outcome of the investigation. If the item cannot be traced, please confirm that it is classed as lost so that we can submit a claim.\n\nDetails:\n${detailsBlock(f)}\n\n${signOff(f)}`
    return { to, subject, body, missing, needsManager: false }
  }

  if (kind === 'challenge') {
    const subject = `Request for review – delivery disputed – ${f.tracking}${refPart(f)}`
    const body = `${g}\n\nThank you for your reply${latestRef(f) ? ` on case ${latestRef(f)}` : ''} about tracking number ${f.tracking}. Our customer still has not received the item, and we do not believe it was delivered correctly:\n\n[MISSING: what the proof-of-delivery photo or GPS shows, and why it does not match the delivery address]\n\nPlease escalate this for a second review and confirm whether the item can be treated as lost so that we can submit a claim.\n\nDetails:\n${detailsBlock(f)}\n\n${signOff(f)}`
    return { to, subject, body, missing, needsManager: true }
  }

  if (kind === 'info_reply') {
    const subject = `Re: requested information – ${f.tracking}${refPart(f)}`
    const body = `${g}\n\nThank you for your email${latestRef(f) ? ` about case ${latestRef(f)}` : ''}.${f.carrierAsked ? ` You asked: ${f.carrierAsked}` : ''}\n\n[MISSING: our answer]\n\nDetails:\n${detailsBlock(f)}\n\n${signOff(f)}`
    return { to, subject, body, missing, needsManager: false }
  }

  // claim_pack: text to paste into the carrier's claims portal (never emailed)
  const claimValue = f.claimed ?? f.value
  const subject = `${carrier.short} claim – ${f.tracking}${f.orderId ? ` – ${f.orderId}` : ''}`
  const what =
    f.issue === 'empty_parcel' ? 'The parcel was delivered without its contents.'
    : f.issue === 'damaged' ? 'The item was damaged in transit.'
    : f.issue === 'delivered_not_received' ? 'The item is shown as delivered but the recipient did not receive it, and the carrier could not show a correct delivery.'
    : 'The item was not delivered and the carrier has confirmed it cannot be traced.'
  const body = `CLAIM SUMMARY (paste into ${carrier.claimRoute})\n\n${bullets([
    ['Tracking number', f.tracking],
    ['Service', f.service],
    ['Date posted', fmtDate(f.postedOn)],
    ['Contents', f.product],
    ['Value claimed', money(claimValue)],
    ['Order reference', f.orderId],
    ['Carrier case reference(s)', f.carrierRefs.length ? f.carrierRefs.join(', ') : null],
  ])}\n\nWhat happened: ${what}\n\nEvidence to attach:\n* Proof of posting (Click & Drop / manifest / counter receipt)\n* Proof of value (sales invoice or Amazon order showing the price)\n* ${f.issue === 'empty_parcel' || f.issue === 'damaged' ? 'Photos of the packaging and contents as received' : "The carrier's email confirming the item could not be traced"}\n\nAfter submitting, click "Mark claim submitted" in ReplyIQ and enter the claim reference.`
  return { to: null, subject, body, missing, needsManager: (claimValue ?? 0) > 500 }
}
