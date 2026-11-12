// "Staff can send routine replies": the pure eligibility rules (evaluateRoutine) and the setting's defaults.
// ai.ts imports reply_instructions.md with ?raw (a Vite feature), so register a tiny loader first.
import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

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
const { evaluateRoutine, getApprovalSettings, DEFAULT_APPROVAL } = await import('../src/approval')

const kase: any = { customer_first_name: 'Sam', customer_last_name: 'Jones', customer_email: null, customer_phone: null, customer_address: null,
  approved_repair_price: null, repair_quote_accepted: null, refund_issued: false, a_to_z_open: null, chargeback_open: false, battery_flag: false, delivery_date: null, device_model: 'iPhone 13' }
const CLEAN = 'Dear Sam,\n\nThank you for your message. We have noted your question and will keep you updated.\n\nKind regards,\nCustomer Support Team'
const inbound = (body: string) => [{ direction: 'inbound' as const, body, sent_at: '2026-11-12T09:00:00Z', sender: 'Customer', kind: 'message' }]
const base = (over: any = {}) => ({
  draft: { draft_text: CLEAN, mode: 'customer', check_result: 'PASS', needs_manager: false, needs_manager_reason: null, ...(over.draft ?? {}) },
  kase: { ...kase, ...(over.kase ?? {}) },
  inbound: over.inbound ?? inbound('Hello, where is my order?'),
  openAtozEvents: over.openAtozEvents ?? false,
  openChargebackEvents: over.openChargebackEvents ?? false,
})
const why = (over: any) => evaluateRoutine(base(over)).reasons.join(' | ')

test('a clean routine reply is eligible', () => {
  const e = evaluateRoutine(base())
  assert.equal(e.eligible, true, e.reasons.join('; '))
  assert.deepEqual(e.reasons, [])
})

test('each of the three case blockers stops it on its own: open A-to-Z, open chargeback, battery_flag', () => {
  assert.match(why({ kase: { a_to_z_open: true } }), /A-to-Z claim open on this case/)
  assert.match(why({ kase: { chargeback_open: true } }), /Chargeback open on this case/)
  assert.match(why({ kase: { battery_flag: true } }), /Battery \/ heat flag/)
  // open Amazon notices count even when the case flag was never ticked
  assert.match(why({ openAtozEvents: true }), /A-to-Z claim from Amazon is still open/)
  assert.match(why({ openChargebackEvents: true }), /chargeback from Amazon is still open/)
  for (const o of [{ kase: { a_to_z_open: true } }, { kase: { chargeback_open: true } }, { kase: { battery_flag: true } }, { openAtozEvents: true }, { openChargebackEvents: true }])
    assert.equal(evaluateRoutine(base(o)).eligible, false)
})

test('guardrail must be PASS with NO warnings, judged on a fresh run as well as the stored result', () => {
  // warning only (no sign-off): stored result is still PASS, but a warning is not allowed
  const warn = evaluateRoutine(base({ draft: { draft_text: 'Dear Sam,\n\nWe have noted your question and will keep you updated.' } }))
  assert.equal(warn.eligible, false)
  assert.ok(warn.findings.every((f) => f.severity === 'warn') && warn.findings.length > 0)
  assert.match(warn.reasons.join('|'), /Guardrail warning/)
  // a FAIL finding (surname)
  assert.match(why({ draft: { draft_text: CLEAN.replace('Thank you', 'Mr Jones, thank you') } }), /Guardrail check fails/)
  // stored result not PASS, even though the text itself is clean now
  assert.match(why({ draft: { check_result: 'FAIL' } }), /saved guardrail result is not PASS/)
  assert.match(why({ draft: { check_result: null } }), /saved guardrail result is not PASS/)
})

test('needs_manager: the stored flag blocks, and so does a fresh recompute from the live case and thread', () => {
  assert.match(why({ draft: { needs_manager: true, needs_manager_reason: 'flagged by model' } }), /Marked needs-manager \(flagged by model\)/)
  // stored flag is stale-false, but the customer has since threatened a chargeback / A-to-Z / trading standards
  assert.match(why({ inbound: inbound('I will go to Trading Standards if this is not fixed') }), /Needs a manager: customer mentions legal/)
  assert.match(why({ inbound: inbound('I have raised an A-to-Z claim') }), /Needs a manager/)
  // battery safety wording in the thread
  assert.match(why({ inbound: inbound('The battery is swollen and the phone is very hot') }), /Needs a manager: swollen\/hot\/burning battery/)
  // refund already issued
  assert.match(why({ kase: { refund_issued: true } }), /Needs a manager: refund already issued/)
  // offering more than £15
  assert.match(why({ draft: { draft_text: CLEAN.replace('will keep you updated', 'will refund £40 to you') } }), /refund above £15|£15/)
})

test('Seller Central / Amazon statements never qualify', () => {
  const e = evaluateRoutine(base({ draft: { mode: 'seller_central_atoz' } }))
  assert.equal(e.eligible, false)
  assert.match(e.reasons.join('|'), /always need a manager/)
})

test('the snapshot records what was verified', () => {
  const e = evaluateRoutine(base())
  assert.equal(e.snapshot.rule, 'staff_routine_reply')
  assert.equal(e.snapshot.a_to_z_open, false)
  assert.equal(e.snapshot.chargeback_open, false)
  assert.equal(e.snapshot.battery_flag, false)
  assert.equal(e.snapshot.needs_manager, false)
})

test('setting: defaults to ON, honours a saved value, and FAILS CLOSED if the settings table cannot be read', async () => {
  assert.equal(DEFAULT_APPROVAL.staff_can_send_routine, true)
  const stub = (rows: any[] | Error) => ((..._a: any[]) => (rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows))) as any
  assert.equal((await getApprovalSettings(stub([]))).staff_can_send_routine, true) // nothing saved → ON
  assert.equal((await getApprovalSettings(stub([{ value: {} }]))).staff_can_send_routine, true) // saved but no key → default
  assert.equal((await getApprovalSettings(stub([{ value: { staff_can_send_routine: false } }]))).staff_can_send_routine, false)
  assert.equal((await getApprovalSettings(stub([{ value: { staff_can_send_routine: 'yes' } }]))).staff_can_send_routine, true) // junk → default, never truthy-by-accident of the junk
  const err = await getApprovalSettings(stub(new Error('connection lost')))
  assert.equal(err.staff_can_send_routine, false)
  assert.equal(err.read_error, true)
})
