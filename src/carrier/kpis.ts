// Carrier KPIs for support staff. Pure functions: given the carrier cases and their timelines, work out every
// "clock" a member of staff is measured on, when it started, when it was due and when (if) it was done.
//
//   investigate  customer reported a delivery problem      → investigation sent to the carrier
//   claim        carrier said "submit a claim"              → claim lodged on the carrier's website
//   info         carrier asked us for information           → our reply sent
//   order_id     parcel added to the desk without an order  → order ID added (or "no customer order" confirmed)
//   customer     carrier gave news the customer must hear   → customer told
//
// Targets are in working days (England & Wales, Europe/London), counted from the day after the clock starts:
// a step due "1 working day" after a Monday report is late from Wednesday 00:00.
import { addWorkingDays, endOfLondonDay, workingDaysBetween } from './workdays'

export type KpiStep = 'investigate' | 'claim' | 'info' | 'order_id' | 'customer'
export const KPI_STEPS: KpiStep[] = ['investigate', 'claim', 'info', 'order_id', 'customer']
export const KPI_LABEL: Record<KpiStep, { title: string; from: string; to: string }> = {
  investigate: { title: 'Raise investigation', from: 'Customer reported a delivery problem', to: 'Investigation sent to the carrier' },
  claim: { title: 'Lodge claim', from: 'Carrier said submit a claim', to: 'Claim lodged on the carrier website' },
  info: { title: 'Answer carrier', from: 'Carrier asked for information', to: 'Information sent' },
  order_id: { title: 'Add order ID', from: 'Parcel on the desk without an order ID', to: 'Order ID added' },
  customer: { title: 'Update customer', from: 'Carrier gave news for the customer', to: 'Customer told' },
}

export type KpiCase = {
  id: number
  tracking: string | null
  carrier: string
  case_id: number | null
  case_ref?: string | null
  order_id: string | null
  no_order: boolean
  assigned_to: number | null
  status: string
  reported_at: string | Date | null
  raised_at: string | Date | null
  closed_at: string | Date | null
  order_id_requested_at: string | Date | null
  order_id_window_days: number | null
  order_id_set_at: string | Date | null
  order_id_set_by: number | null
  customer_update_due: boolean
  customer_update_due_at: string | Date | null
  customer_told_at: string | Date | null
}
export type KpiMessage = { direction: 'inbound' | 'outbound' | 'note'; kind: string; sent_at: string | Date; sent_by: number | null; extracted?: any }

export type KpiState = 'on_time' | 'late' | 'open' | 'overdue'
export type KpiItem = {
  step: KpiStep
  carrier_case_id: number
  tracking: string | null
  case_ref: string | null
  started_at: string
  due_at: string
  done_at: string | null
  working_days: number // working days taken (or so far, if not done)
  state: KpiState
  owner_id: number | null // who did it, or (if not done) who owns the case
}

const d = (v: string | Date | null | undefined) => (v == null ? null : new Date(v))
const CLOSED = ['paid', 'partially_paid', 'rejected', 'closed']

function item(step: KpiStep, k: KpiCase, start: Date, done: Date | null, targetDays: number, doneBy: number | null, now: Date): KpiItem {
  const due = endOfLondonDay(addWorkingDays(start, targetDays))
  const state: KpiState = done ? (done <= due ? 'on_time' : 'late') : now > due ? 'overdue' : 'open'
  return {
    step,
    carrier_case_id: k.id,
    tracking: k.tracking,
    case_ref: k.case_ref ?? null,
    started_at: start.toISOString(),
    due_at: due.toISOString(),
    done_at: done ? done.toISOString() : null,
    working_days: workingDaysBetween(start, done ?? now),
    state,
    owner_id: done ? (doneBy ?? k.assigned_to) : k.assigned_to,
  }
}

/** Every KPI clock for one carrier case. `targetDays` is the target for all steps (order ID uses the case's own window). */
export function kpiItems(k: KpiCase, messages: KpiMessage[], opts: { targetDays: number; now?: Date }): KpiItem[] {
  const now = opts.now ?? new Date()
  const t = opts.targetDays
  const msgs = [...messages].map((m) => ({ ...m, at: new Date(m.sent_at) })).sort((a, b) => +a.at - +b.at)
  const out: KpiItem[] = []
  const isClosed = CLOSED.includes(k.status)

  // 1. Customer reported → investigation raised
  const reported = d(k.reported_at)
  if (reported) {
    const firstOut = msgs.find((m) => m.direction === 'outbound' && +m.at >= +reported - 60_000)
    const raised = firstOut?.at ?? d(k.raised_at)
    // A case closed without ever being raised (parcel turned up, customer cancelled) has nothing to measure
    if (raised || !isClosed) out.push(item('investigate', k, reported, raised && +raised >= +reported ? raised : raised ? reported : null, t, firstOut?.sent_by ?? null, now))
  }

  // 2. Carrier said "claim" → claim lodged. Clock starts at the first decision_lost email, or when staff set the status by hand.
  const claimStart = msgs.find((m) => (m.direction === 'inbound' && m.kind === 'decision_lost') || (m.kind === 'status_change' && m.extracted?.to === 'claim_form_needed'))
  if (claimStart) {
    const lodged = msgs.find((m) => m.kind === 'claim_submitted' && +m.at >= +claimStart.at)
    // Closed or written off without a claim still counts: that is exactly the loss this KPI is meant to prevent
    out.push(item('claim', k, claimStart.at, lodged?.at ?? null, t, lodged?.sent_by ?? null, now))
  }

  // 3. Carrier asked for information → our next email. Each request is its own clock.
  for (const req of msgs.filter((m) => m.direction === 'inbound' && m.kind === 'info_request')) {
    const reply = msgs.find((m) => m.direction === 'outbound' && +m.at > +req.at)
    const nextReq = msgs.find((m) => m.direction === 'inbound' && m.kind === 'info_request' && +m.at > +req.at)
    if (nextReq && (!reply || +nextReq.at < +reply.at)) continue // superseded by a later request before we answered: score the later one
    if (!reply && isClosed) continue // closed without needing the answer
    out.push(item('info', k, req.at, reply?.at ?? null, t, reply?.sent_by ?? null, now))
  }

  // 4. Order ID on the case
  const asked = d(k.order_id_requested_at)
  if (asked) {
    const set = d(k.order_id_set_at)
    const has = !!k.order_id || k.no_order
    // Filled in by ReplyIQ when the parcel was created (e.g. opened from an Amazon case): nobody had to do anything.
    // A person who adds it within the first minute is still scored (order_id_set_by is only set when staff save it).
    if (!(has && set && k.order_id_set_by == null && +set - +asked < 60_000)) out.push(item('order_id', k, asked, has ? (set ?? asked) : null, k.order_id_window_days ?? t, k.order_id_set_by, now))
  }

  // 5. Carrier news → customer told
  const newsAt = d(k.customer_update_due_at)
  if (newsAt) {
    const told = k.customer_update_due ? null : d(k.customer_told_at)
    if (told || k.customer_update_due) out.push(item('customer', k, newsAt, told, t, null, now))
  }
  return out
}

export type StepSummary = {
  step: KpiStep
  title: string
  from: string
  to: string
  total: number
  on_time: number
  late: number
  overdue: number
  open: number
  on_time_pct: number | null // on time ÷ (done + overdue); open-within-target items are not scored yet
  avg_days: number | null // average working days for finished items
}

/** Summarise items per step (optionally for one owner). Only clocks that STARTED inside [from, to] count. */
export function summarise(items: KpiItem[], range: { from: Date; to: Date }, ownerId?: number | null): StepSummary[] {
  const inRange = items.filter((i) => +new Date(i.started_at) >= +range.from && +new Date(i.started_at) <= +range.to && (ownerId === undefined || i.owner_id === ownerId))
  return KPI_STEPS.map((step) => {
    const xs = inRange.filter((i) => i.step === step)
    const done = xs.filter((i) => i.done_at)
    const onTime = xs.filter((i) => i.state === 'on_time').length
    const late = xs.filter((i) => i.state === 'late').length
    const overdue = xs.filter((i) => i.state === 'overdue').length
    const scored = onTime + late + overdue
    return {
      step,
      ...KPI_LABEL[step],
      total: xs.length,
      on_time: onTime,
      late,
      overdue,
      open: xs.filter((i) => i.state === 'open').length,
      on_time_pct: scored ? Math.round((onTime / scored) * 1000) / 10 : null,
      avg_days: done.length ? Math.round((done.reduce((s, i) => s + i.working_days, 0) / done.length) * 10) / 10 : null,
    }
  })
}
