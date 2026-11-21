// Closed-day replies: which days are closed, when the closed spell started, and the holding-reply guard.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { closedReason, nextWorkingDay, closedSpellStart, longDate, FALLBACK_BANK_HOLIDAYS as H } from '../src/closedDays'
import { register } from 'node:module'
// overview.ts → ai.ts imports reply_instructions.md?raw (Vite); same tiny loader as tests/ai.test.ts.
register('data:text/javascript,' + encodeURIComponent(`
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
export async function resolve(spec, ctx, next) {
  if (spec.endsWith('?raw')) return { url: new URL(spec, ctx.parentURL).href + '?raw', shortCircuit: true }
  return next(spec, ctx)
}
export async function load(url, ctx, next) {
  if (url.endsWith('?raw')) return { format: 'module', source: 'export default ' + JSON.stringify(readFileSync(fileURLToPath(url.slice(0, -4)), 'utf8')), shortCircuit: true }
  return next(url, ctx)
}`))
const { holdingProblems, holdingTemplate, channelOf } = await import('../src/autoReply')

test('weekends and bank holidays are closed', () => {
  assert.equal(closedReason('2026-11-21', H), 'Saturday')
  assert.equal(closedReason('2026-11-22', H), 'Sunday')
  assert.equal(closedReason('2026-11-23', H), null)
  assert.equal(closedReason('2026-12-25', H), 'Christmas Day')
  assert.equal(closedReason('2026-12-28', H), 'Boxing Day (substitute day)')
  assert.equal(closedReason('2026-12-24', H, { '2026-12-24': 'Christmas Eve' }), 'Christmas Eve')
})

test('next working day skips weekends and bank holidays', () => {
  assert.equal(nextWorkingDay('2026-11-21', H), '2026-11-23')
  assert.equal(nextWorkingDay('2026-12-24', H), '2026-12-29') // Fri 25 Christmas, Sat, Sun, Mon 28 Boxing Day substitute
  assert.equal(nextWorkingDay('2027-03-26', H), '2027-03-30') // Good Friday → Easter Monday → Tuesday
  assert.equal(longDate('2026-11-23'), 'Monday 23 November')
})

test('closed spell starts 17:00 London on the last working day (GMT and BST)', () => {
  const sat = closedSpellStart(new Date('2026-11-21T11:00:00Z'), H)!
  assert.equal(sat.since.toISOString(), '2026-11-20T17:00:00.000Z') // GMT
  assert.equal(sat.reopens, '2026-11-23')
  const sunBst = closedSpellStart(new Date('2026-06-14T09:00:00Z'), H)!
  assert.equal(sunBst.since.toISOString(), '2026-06-12T16:00:00.000Z') // 17:00 BST on Friday
  const boxing = closedSpellStart(new Date('2026-12-28T10:00:00Z'), H)!
  assert.equal(boxing.since.toISOString(), '2026-12-24T17:00:00.000Z') // Thursday 24th, before Christmas Day
  assert.equal(boxing.reason, 'Boxing Day (substitute day)')
  assert.equal(closedSpellStart(new Date('2026-11-23T10:00:00Z'), H), null) // Monday: open
})

test('holding reply guard: no decisions, never says automatic', () => {
  const ok = 'Dear Anna,\n\nThank you for your message about your iPhone 13. We are sorry the screen is flickering. A member of our team will reply with a full answer by Monday 23 November.\n\nOur returns team remains available over the weekend and on bank holidays.\n\nKind regards,\nCustomer Support Team'
  assert.deepEqual(holdingProblems(ok), [])
  assert.match(holdingProblems(ok.replace('We are sorry', 'We will refund you. We are sorry')).join(), /decision/)
  assert.match(holdingProblems(ok.replace('Thank you', 'This is an automated reply. Thank you')).join(), /automatic/)
  assert.match(holdingProblems(ok.replace('You will', '').replace('Thank you', 'You will receive a replacement. Thank you')).join(), /decision/)
  assert.match(holdingProblems(ok.replace('Customer Support Team', 'Saigates')).join(), /sign-off/)
})

test('standard holding wording is safe and personal', () => {
  const t = holdingTemplate({ customer_first_name: 'Anna', device_model: 'iPhone 13 128GB Blue', order_id: '202-1' } as any, '2026-11-23', 'Our returns team remains available over the weekend and on bank holidays.', true)
  assert.match(t, /^Dear Anna,/)
  assert.match(t, /iPhone 13 128GB Blue/)
  assert.match(t, /Monday 23 November/)
  assert.match(t, /stop using and charging/)
  assert.deepEqual(holdingProblems(t), [])
})

test('only Amazon buyer messages are recognised for now', () => {
  assert.equal(channelOf({ customer_reply_to: 'abc123@marketplace.amazon.co.uk' }), 'amazon')
  assert.equal(channelOf({ customer_reply_to: 'someone@gmail.com' }), null)
  assert.equal(channelOf({ customer_reply_to: null }), null)
})

const { holdingPlan, inReplyWindow } = await import('../src/closedDays')
const at = (s: string) => new Date(s)
test('replies only 9am–5pm on closed days', () => {
  assert.equal(inReplyWindow(at('2026-11-21T08:59:00Z'), H), false)
  assert.equal(inReplyWindow(at('2026-11-21T09:00:00Z'), H), true)
  assert.equal(inReplyWindow(at('2026-11-21T16:59:00Z'), H), true)
  assert.equal(inReplyWindow(at('2026-11-21T17:00:00Z'), H), false)
  assert.equal(inReplyWindow(at('2026-11-23T10:00:00Z'), H), false) // Monday: staff
  assert.equal(inReplyWindow(at('2026-06-13T08:30:00Z'), H), true) // 09:30 BST
})
test('holding reply: as late as possible inside 48 hours, only if staff are not back in time', () => {
  // Friday 18:00 message, normal weekend: deadline Sunday 18:00, staff back Monday 09:00 → send Sunday 16:45.
  let p = holdingPlan(at('2026-11-20T18:00:00Z'), at('2026-11-21T09:15:00Z'), H)
  assert.equal(p.needed, true); assert.equal(p.sendAt!.toISOString(), '2026-11-22T16:45:00.000Z')
  // Saturday 10:00 message: deadline Monday 10:00 → staff back 09:00 with only 1 hour → still needs one, Sunday 16:45.
  p = holdingPlan(at('2026-11-21T10:00:00Z'), at('2026-11-21T10:15:00Z'), H)
  assert.equal(p.needed, true); assert.equal(p.sendAt!.toISOString(), '2026-11-22T16:45:00.000Z')
  // Saturday 16:00 message: deadline Monday 16:00, staff back 09:00 with 7 hours → left for staff.
  p = holdingPlan(at('2026-11-21T16:00:00Z'), at('2026-11-21T16:15:00Z'), H)
  assert.equal(p.needed, false)
  // Sunday 11:00 message: deadline Tuesday → staff.
  assert.equal(holdingPlan(at('2026-11-22T11:00:00Z'), at('2026-11-22T11:15:00Z'), H).needed, false)
  // Christmas: Thursday 24 Dec 18:00 message; closed Fri 25 – Mon 28; deadline Sat 26 18:00 → Sat 16:45.
  p = holdingPlan(at('2026-12-24T18:00:00Z'), at('2026-12-25T09:15:00Z'), H)
  assert.equal(p.sendAt!.toISOString(), '2026-12-26T16:45:00.000Z')
  // Customer writes again Sat 26 Dec 17:30: deadline Mon 28 17:30, staff back Tue 29 → second holding reply Mon 28 16:30.
  p = holdingPlan(at('2026-12-26T17:30:00Z'), at('2026-12-27T09:15:00Z'), H)
  assert.equal(p.needed, true); assert.equal(p.sendAt!.toISOString(), '2026-12-28T16:30:00.000Z')
  // Deadline before the next window (message Sat 06:00, deadline Mon 06:00, first slot Sunday): Sunday 16:45.
  assert.equal(holdingPlan(at('2026-11-21T06:00:00Z'), at('2026-11-21T09:00:00Z'), H).sendAt!.toISOString(), '2026-11-22T16:45:00.000Z')
  // BST: Friday 17:30 BST message, deadline Sunday 17:30 BST → Sunday 16:30 BST = 15:30Z.
  p = holdingPlan(at('2026-06-12T16:30:00Z'), at('2026-06-13T08:15:00Z'), H)
  assert.equal(p.sendAt!.toISOString(), '2026-06-14T15:30:00.000Z')
})
test('a second holding reply does not repeat the first', () => {
  const first = 'Dear Anna,\n\nThank you for your message about your iPhone 13 128GB Blue. We have read it carefully, and a member of our team will come back to you with a full answer by Tuesday 29 December.\n\nOur returns team remains available over the weekend and on bank holidays.\n\nKind regards,\nCustomer Support Team'
  const k = { customer_first_name: 'Anna', device_model: 'iPhone 13 128GB Blue' } as any
  const note = 'Our returns team remains available over the weekend and on bank holidays.'
  const again = holdingTemplate(k, '2026-12-29', note, false, true)
  assert.deepEqual(holdingProblems(again, [{ body: first, sent_at: '' }], note), [])
  assert.deepEqual(holdingProblems(first, [{ body: first, sent_at: '' }], note), ['repeats an earlier reply'])
})
