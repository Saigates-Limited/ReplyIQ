// Status rules for a parcel's carrier case. Pure functions: given the case and an event, return the fields to change.
// The same rules the Monday/Friday "Carrier Claims Desk" routine used, now applied the moment an email arrives.
import { CARRIERS, type CarrierId } from './carriers'
import type { InboundKind } from './classify'
import type { DraftKind } from './templates'
import { addWorkingDays, endOfLondonDay, workingDaysBetween } from './workdays'

export type CarrierStatus =
  | 'to_raise' | 'awaiting_carrier' | 'action_needed' | 'claim_form_needed' | 'claim_submitted' | 'escalated'
  | 'paid' | 'partially_paid' | 'rejected' | 'closed'

export const STATUS_LABEL: Record<CarrierStatus | 'sla_breach', string> = {
  to_raise: 'Ready to raise',
  awaiting_carrier: 'Awaiting carrier',
  sla_breach: 'Carrier overdue',
  action_needed: 'Action needed from us',
  claim_form_needed: 'Claim to submit',
  claim_submitted: 'Claim submitted',
  escalated: 'Escalated',
  paid: 'Paid',
  partially_paid: 'Partially paid',
  rejected: 'Rejected',
  closed: 'Closed',
}
export const CLOSED_STATUSES: CarrierStatus[] = ['paid', 'partially_paid', 'rejected', 'closed']
export const WAITING_STATUSES: CarrierStatus[] = ['awaiting_carrier', 'claim_submitted', 'escalated']
export const ON_US_STATUSES: CarrierStatus[] = ['to_raise', 'action_needed', 'claim_form_needed']

export type CarrierCaseRow = {
  id: number
  carrier: CarrierId
  tracking: string | null
  status: CarrierStatus
  value: string | number | null
  claimed: string | number | null
  paid: string | number | null
  carrier_refs: string[]
  claim_ref: string | null
  raised_at: string | Date | null
  last_us_at: string | Date | null
  last_carrier_at: string | Date | null
  carrier_reply_type: 'auto_ack' | 'replied' | 'decision' | null
  sla_due_at: string | Date | null
}

export type Patch = Partial<{
  status: CarrierStatus
  carrier_refs: string[]
  claim_ref: string | null
  raised_at: Date
  last_us_at: Date
  last_carrier_at: Date
  carrier_reply_type: 'auto_ack' | 'replied' | 'decision'
  sla_due_at: Date | null
  paid: number
  paid_on: string
  claimed: number
  next_action: string
  next_due: string | null
  closed_at: Date | null
}>

const num = (v: unknown) => (v == null || v === '' ? null : Number(v))
const due = (from: Date, days: number) => endOfLondonDay(addWorkingDays(from, days))
const ymd = (d: Date) => d.toISOString().slice(0, 10)
const ref = (k: CarrierCaseRow) => k.carrier_refs[k.carrier_refs.length - 1]

/** Status shown to staff: a waiting case whose reply date has passed is "Carrier overdue". */
export function displayStatus(k: Pick<CarrierCaseRow, 'status' | 'sla_due_at'>, now = new Date()): CarrierStatus | 'sla_breach' {
  if (WAITING_STATUSES.includes(k.status) && k.sla_due_at && new Date(k.sla_due_at) < now) return 'sla_breach'
  return k.status
}

/** Working days since our last email (for chase wording and the "Chase now" list). */
export const waitingDays = (k: CarrierCaseRow, now = new Date()) => (k.last_us_at ? workingDaysBetween(new Date(k.last_us_at), now) : null)

const mergeRefs = (k: CarrierCaseRow, refs: string[]) => [...new Set([...(k.carrier_refs ?? []), ...refs])]

/** We sent the carrier an email (investigation, chase, challenge, info reply, postage refund). */
export function onOutbound(k: CarrierCaseRow, kind: DraftKind, at: Date): Patch {
  const c = CARRIERS[k.carrier]
  const sla = due(at, c.replyDays)
  return {
    status: 'awaiting_carrier',
    raised_at: (k.raised_at ? new Date(k.raised_at) : at) as Date,
    last_us_at: at,
    sla_due_at: sla,
    next_action: `Wait for ${c.short} reply${kind === 'chase' ? ' to our chase' : ''} – due ${ymd(sla)}`,
    next_due: ymd(sla),
    closed_at: null,
  }
}

/** Staff lodged the claim in the carrier's portal. */
export function onClaimSubmitted(k: CarrierCaseRow, at: Date, claimRef: string | null, claimed: number | null): Patch {
  const c = CARRIERS[k.carrier]
  const sla = due(at, c.claimDecisionDays)
  return {
    status: 'claim_submitted',
    claim_ref: claimRef ?? k.claim_ref,
    claimed: claimed ?? num(k.claimed) ?? num(k.value) ?? undefined,
    sla_due_at: sla,
    next_action: `Wait for ${c.short} claim decision – due ${ymd(sla)}`,
    next_due: ymd(sla),
    closed_at: null,
  } as Patch
}

/** A carrier email arrived and was classified. */
export function onInbound(k: CarrierCaseRow, kind: InboundKind, at: Date, x: { caseRefs?: string[]; claimRef?: string | null; amount?: number | null } = {}): Patch {
  const c = CARRIERS[k.carrier]
  const refs = mergeRefs(k, x.caseRefs ?? [])
  const base: Patch = { carrier_refs: refs }
  if (x.claimRef) base.claim_ref = x.claimRef
  const r = refs[refs.length - 1]
  const caseTxt = r ? ` case ${r}` : ''

  switch (kind) {
    case 'auto_ack':
    case 'notification':
      // Not a reply: the SLA keeps running from our email. Record the reference only.
      return { ...base, ...(k.carrier_reply_type ? {} : { carrier_reply_type: 'auto_ack' as const }) }
    case 'holding_reply': {
      const sla = due(at, c.replyDays)
      return { ...base, last_carrier_at: at, carrier_reply_type: 'replied', status: k.status === 'claim_submitted' || k.status === 'escalated' ? k.status : 'awaiting_carrier', sla_due_at: sla, next_action: `${c.short} investigating${caseTxt} – chase if nothing by ${ymd(sla)}`, next_due: ymd(sla) }
    }
    case 'info_request':
      return { ...base, last_carrier_at: at, carrier_reply_type: 'replied', status: 'action_needed', sla_due_at: null, next_action: `Reply to ${c.short}${caseTxt} with the information they asked for`, next_due: ymd(at) }
    case 'decision_lost': {
      const v = num(k.value)
      return { ...base, last_carrier_at: at, carrier_reply_type: 'decision', status: 'claim_form_needed', sla_due_at: null, next_action: `Submit ${c.short} loss claim via ${c.claimRoute}${v ? ` (£${v.toFixed(2)})` : ''}`, next_due: ymd(at) }
    }
    case 'decision_delivered':
      return { ...base, last_carrier_at: at, carrier_reply_type: 'decision', status: 'rejected', sla_due_at: null, closed_at: at, next_action: `${c.short} says delivered – share the proof of delivery with the customer, or challenge it`, next_due: null }
    case 'decision_rejected':
      return { ...base, last_carrier_at: at, carrier_reply_type: 'decision', status: 'rejected', sla_due_at: null, closed_at: at, next_action: `${c.short} declined – challenge it or write it off`, next_due: null }
    case 'escalation': {
      const sla = due(at, c.claimDecisionDays)
      return { ...base, last_carrier_at: at, carrier_reply_type: 'replied', status: 'escalated', sla_due_at: sla, next_action: `${c.short} reviewing${caseTxt} – decision due ${ymd(sla)}`, next_due: ymd(sla) }
    }
    case 'claim_settled': {
      if (x.amount == null) return { ...base, last_carrier_at: at, carrier_reply_type: 'decision', next_action: `${c.short} says the claim is settled – check the amount paid`, next_due: ymd(at) }
      const paid = (num(k.paid) ?? 0) + x.amount
      const target = num(k.claimed) ?? num(k.value)
      const full = target == null || paid >= target - 0.005
      return { ...base, last_carrier_at: at, carrier_reply_type: 'decision', paid, paid_on: ymd(at), status: full ? 'paid' : 'partially_paid', sla_due_at: null, closed_at: at, next_action: full ? 'Nothing – paid' : `Partially paid £${paid.toFixed(2)} of £${target!.toFixed(2)} – accept or challenge`, next_due: null }
    }
    default:
      return { ...base, last_carrier_at: at, carrier_reply_type: k.carrier_reply_type === 'decision' ? 'decision' : 'replied', next_action: `Read the new ${c.short} email${caseTxt} and set the status`, next_due: ymd(at) }
  }
}

/** Which email the queue should offer next for a case (null = nothing to send). */
export function suggestedDraft(k: CarrierCaseRow, now = new Date()): DraftKind | null {
  const s = displayStatus(k, now)
  if (s === 'to_raise') return 'investigation'
  if (s === 'sla_breach') return 'chase'
  if (s === 'action_needed') return 'info_reply'
  if (s === 'claim_form_needed') return 'claim_pack'
  return null
}

export { ref as latestCarrierRef }
