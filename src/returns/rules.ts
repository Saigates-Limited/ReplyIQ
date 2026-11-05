// Business rules for physical returns. Pure functions so they can be unit-tested; the API applies their results.
import { workingDaysBetween } from '../carrier/workdays'

export const RETURN_STATUSES = ['expected', 'received', 'inspected', 'outcome_agreed', 'closed'] as const
export type ReturnStatus = (typeof RETURN_STATUSES)[number]
export const STATUS_LABEL: Record<ReturnStatus, string> = { expected: 'Expected', received: 'Received', inspected: 'Inspected', outcome_agreed: 'Outcome agreed', closed: 'Closed' }

export const REASONS = ['faulty', 'cosmetic', 'change_of_mind', 'returned_to_sender', 'wrong_item'] as const
export type Reason = (typeof REASONS)[number]
export const REASON_LABEL: Record<Reason, string> = { faulty: 'Faulty', cosmetic: 'Cosmetic', change_of_mind: 'Change of mind', returned_to_sender: 'Returned to sender', wrong_item: 'Wrong item' }

export const CABLES = ['returned', 'not_returned', 'damaged', 'not_applicable'] as const
export type Cable = (typeof CABLES)[number]
export const CABLE_LABEL: Record<Cable, string> = { returned: 'Cable returned', not_returned: 'No cable returned', damaged: 'Cable damaged/burnt', not_applicable: 'Not applicable' }

export const OUTCOMES = ['refund', 'partial_refund', 'replacement', 'repair', 'resend'] as const
export type Outcome = (typeof OUTCOMES)[number]
export const OUTCOME_LABEL: Record<Outcome, string> = { refund: 'Refund', partial_refund: 'Partial refund', replacement: 'Replacement', repair: 'Repair', resend: 'Resend' }

export const DISPOSITIONS = ['back_to_stock', 'repair', 'return_to_supplier', 'write_off'] as const
export type Disposition = (typeof DISPOSITIONS)[number]
export const DISPOSITION_LABEL: Record<Disposition, string> = { back_to_stock: 'Back to stock', repair: 'Repair', return_to_supplier: 'Return to supplier', write_off: 'Write off' }

export const PARTIAL_REFUND_MANAGER_OVER = 15 // GBP
export const OVERDUE_AFTER_WORKING_DAYS = 2
export const FRP_UNLOCK_DAYS = 2

/** Words in a reason / fault / note that mean a possible battery safety issue. */
export const BATTERY_RE = /\b(overheat\w*|burn\w*|burnt|swollen|swelling|bulg\w*|hot)\b/i

export type ItemInput = {
  reason_category?: Reason | null
  cable?: Cable | null
  frp_lock?: boolean | null
  outcome?: Outcome | null
  refund_amount?: number | string | null
  fault_found?: string | null
  notes?: string | null
}

export type RuleResult = {
  needsManager: boolean
  managerReasons: string[]
  batteryFlag: boolean
  startActivationLock: boolean
  flags: string[] // informational chips for the UI
}

/** Apply the agreed rules to one phone's inspection + outcome. Never deducts anything; only flags. */
export function evaluateItem(it: ItemInput, returnNotes?: string | null): RuleResult {
  const r: RuleResult = { needsManager: false, managerReasons: [], batteryFlag: false, startActivationLock: false, flags: [] }
  const text = [it.fault_found, it.notes, returnNotes].filter(Boolean).join(' \n ')

  if (it.cable === 'not_returned') {
    if (it.reason_category === 'change_of_mind') { r.needsManager = true; r.managerReasons.push('No cable returned on a change-of-mind return — consider a partial refund (never automatic)') }
    else r.flags.push('No cable returned — restock a cable; no deduction')
  }
  if (it.cable === 'damaged') { r.batteryFlag = true; r.needsManager = true; r.managerReasons.push('Cable damaged/burnt — possible charging/battery safety issue') }
  if (BATTERY_RE.test(text)) { r.batteryFlag = true; if (!r.managerReasons.some((m) => /battery/.test(m))) { r.needsManager = true; r.managerReasons.push('Battery/heat words in fault or notes') } }
  if (it.frp_lock === true) { r.startActivationLock = true; r.flags.push(`Activation lock — customer has ${FRP_UNLOCK_DAYS} days to remove it`) }
  if (it.outcome === 'partial_refund') {
    const amt = Number(it.refund_amount ?? 0)
    if (amt > PARTIAL_REFUND_MANAGER_OVER) { r.needsManager = true; r.managerReasons.push(`Partial refund £${amt.toFixed(2)} is over £${PARTIAL_REFUND_MANAGER_OVER}`) }
  }
  return r
}

/** Received but no outcome after N UK working days → overdue. */
export function isOverdue(ret: { status: string; received_at: string | Date | null }, now = new Date()): boolean {
  if (!ret.received_at) return false
  if (!['received', 'inspected'].includes(ret.status)) return false
  return workingDaysBetween(new Date(ret.received_at), now) >= OVERDUE_AFTER_WORKING_DAYS
}

const dayDiff = (a: string | Date | null | undefined, b: Date) => (a ? Math.floor((b.getTime() - new Date(a).getTime()) / 86400000) : null)

/** Computed, never typed. */
export function daysSince(ret: { order_date: string | Date | null; delivery_date: string | Date | null }, now = new Date()) {
  return { days_since_order: dayDiff(ret.order_date, now), days_since_delivery: dayDiff(ret.delivery_date, now) }
}

/** Status transitions a user may make. Closing needs an outcome on every item. */
export function canMove(from: ReturnStatus, to: ReturnStatus): boolean {
  const order = RETURN_STATUSES.indexOf(from), next = RETURN_STATUSES.indexOf(to)
  return next === order + 1 || (next < order && next >= 1) // forward one step, or back (not to "expected") to correct a mistake
}
