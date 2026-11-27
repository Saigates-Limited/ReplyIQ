// Run: npm run test:unit. Carrier KPI clocks (working days, Europe/London, England & Wales bank holidays).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { kpiItems, summarise, type KpiCase, type KpiMessage } from '../src/carrier/kpis'
import { normaliseCarrier } from '../src/carrier/carriers'

const KULDEEP = 7
const base = (over: Partial<KpiCase> = {}): KpiCase => ({
  id: 1, tracking: 'HZ623769535GB', carrier: 'royal_mail', case_id: 10, case_ref: 'RIQ-1', order_id: '202-5745896-9109132', no_order: false,
  assigned_to: KULDEEP, status: 'awaiting_carrier', reported_at: null, raised_at: null, closed_at: null,
  order_id_requested_at: null, order_id_window_days: 1, order_id_set_at: null, order_id_set_by: null,
  customer_update_due: false, customer_update_due_at: null, customer_told_at: null, ...over,
})
const out = (at: string, kind = 'investigation', by: number | null = KULDEEP): KpiMessage => ({ direction: 'outbound', kind, sent_at: at, sent_by: by })
const inb = (at: string, kind: string): KpiMessage => ({ direction: 'inbound', kind, sent_at: at, sent_by: null })
const note = (at: string, kind: string, extracted: any = {}, by: number | null = KULDEEP): KpiMessage => ({ direction: 'note', kind, sent_at: at, sent_by: by, extracted })
const now = new Date('2026-11-23T17:00:00Z') // Monday

test('investigation raised the next working day is on time; a Friday report is due Monday', () => {
  const k = base({ reported_at: '2026-11-20T15:00:00Z' }) // Friday afternoon
  const [i] = kpiItems(k, [out('2026-11-23T10:00:00Z')], { targetDays: 1, now })
  assert.equal(i.step, 'investigate')
  assert.equal(i.state, 'on_time')
  assert.equal(i.working_days, 1)
  assert.equal(i.owner_id, KULDEEP)
})

test('case 1 (HZ623769535GB): 17 days to raise and 11 days to claim are both late', () => {
  const k = base({ reported_at: '2026-08-16T14:37:00Z', raised_at: '2026-09-02T14:35:00Z', status: 'partially_paid' })
  const items = kpiItems(k, [
    out('2026-09-02T14:35:00Z'),
    inb('2026-09-03T10:59:00Z', 'decision_lost'),
    note('2026-09-14T10:02:00Z', 'claim_submitted'),
  ], { targetDays: 1, now })
  const inv = items.find((i) => i.step === 'investigate')!
  const claim = items.find((i) => i.step === 'claim')!
  assert.equal(inv.state, 'late')
  assert.equal(inv.working_days, 12) // 17 calendar days; 31 Aug was a bank holiday
  assert.equal(claim.state, 'late')
  assert.equal(claim.working_days, 7)
})

test('claim not lodged and past target is overdue; a manual "Claim to submit" status also starts the clock', () => {
  const k = base({ status: 'claim_form_needed' })
  const [c1] = kpiItems(k, [note('2026-11-18T09:00:00Z', 'status_change', { to: 'claim_form_needed' })], { targetDays: 1, now })
  assert.equal(c1.step, 'claim')
  assert.equal(c1.state, 'overdue')
  const [c2] = kpiItems(k, [inb('2026-11-23T09:00:00Z', 'decision_lost')], { targetDays: 1, now })
  assert.equal(c2.state, 'open')
})

test('each carrier information request is its own clock; only the latest unanswered one counts', () => {
  const k = base()
  const items = kpiItems(k, [
    inb('2026-11-16T10:00:00Z', 'info_request'), out('2026-11-16T15:00:00Z', 'info_reply'),
    inb('2026-11-18T10:00:00Z', 'info_request'), inb('2026-11-19T10:00:00Z', 'info_request'),
  ], { targetDays: 1, now })
  const info = items.filter((i) => i.step === 'info')
  assert.equal(info.length, 2)
  assert.equal(info[0].state, 'on_time')
  assert.equal(info[1].state, 'overdue')
  assert.equal(info[1].started_at, '2026-11-19T10:00:00.000Z')
})

test('order ID: backlog gets 2 working days, new parcels 1; an order ID present from the start is not scored', () => {
  const backlog = base({ order_id: null, order_id_requested_at: '2026-11-23T17:30:00Z', order_id_window_days: 2 })
  const [b] = kpiItems(backlog, [], { targetDays: 1, now: new Date('2026-11-25T20:00:00Z') })
  assert.equal(b.state, 'open') // due end of Wed 25 Nov
  const [late] = kpiItems(backlog, [], { targetDays: 1, now: new Date('2026-11-26T09:00:00Z') })
  assert.equal(late.state, 'overdue')
  const filled = base({ order_id_requested_at: '2026-11-23T10:00:00Z', order_id_set_at: '2026-11-23T10:00:00Z' })
  assert.equal(kpiItems(filled, [], { targetDays: 1, now }).filter((i) => i.step === 'order_id').length, 0)
  const added = base({ order_id_requested_at: '2026-11-20T10:00:00Z', order_id_set_at: '2026-11-23T09:00:00Z', order_id_set_by: KULDEEP })
  assert.equal(kpiItems(added, [], { targetDays: 1, now }).find((i) => i.step === 'order_id')!.state, 'on_time')
  const none = base({ order_id: null, no_order: true, order_id_requested_at: '2026-11-20T10:00:00Z', order_id_set_at: '2026-11-20T11:00:00Z' })
  assert.equal(kpiItems(none, [], { targetDays: 1, now }).find((i) => i.step === 'order_id')!.state, 'on_time')
})

test('customer update: open while due, scored when cleared', () => {
  const due = base({ customer_update_due: true, customer_update_due_at: '2026-11-19T09:00:00Z' })
  assert.equal(kpiItems(due, [], { targetDays: 1, now }).find((i) => i.step === 'customer')!.state, 'overdue')
  const told = base({ customer_update_due: false, customer_update_due_at: '2026-11-19T09:00:00Z', customer_told_at: '2026-11-19T12:00:00Z' })
  assert.equal(kpiItems(told, [], { targetDays: 1, now }).find((i) => i.step === 'customer')!.state, 'on_time')
})

test('summary: on-time % counts finished and overdue items, not ones still inside their target', () => {
  const k1 = base({ id: 1, reported_at: '2026-11-16T09:00:00Z' })
  const k2 = base({ id: 2, reported_at: '2026-11-16T09:00:00Z', assigned_to: 8 })
  const k3 = base({ id: 3, reported_at: '2026-11-23T09:00:00Z' })
  const items = [
    ...kpiItems(k1, [out('2026-11-16T12:00:00Z')], { targetDays: 1, now }),
    ...kpiItems(k2, [], { targetDays: 1, now }),
    ...kpiItems(k3, [], { targetDays: 1, now }),
  ]
  const range = { from: new Date('2026-11-01T00:00:00Z'), to: now }
  const inv = summarise(items, range).find((s) => s.step === 'investigate')!
  assert.equal(inv.total, 3)
  assert.equal(inv.on_time, 1)
  assert.equal(inv.overdue, 1)
  assert.equal(inv.open, 1)
  assert.equal(inv.on_time_pct, 50)
  assert.equal(summarise(items, range, KULDEEP).find((s) => s.step === 'investigate')!.total, 2)
})

test('the Add parcel form value "royal_mail" is Royal Mail, not "Other carrier"', () => {
  assert.equal(normaliseCarrier('royal_mail'), 'royal_mail')
  assert.equal(normaliseCarrier('Royal Mail'), 'royal_mail')
  assert.equal(normaliseCarrier('dpd'), 'dpd')
})
