// Context check: judgement rules are confirmed with the model; it can clear a false alarm, never add one. Fetch is stubbed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { imeiCheckDigit } from '../src/returns/imei'

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
const { serverChecks } = await import('../src/ai')
const { reviewInContext, applyCleared, openFindings } = await import('../src/contextCheck')


const kase: any = { id: 1, case_ref: 'RIQ-1225', subject: 'Enquiry from Amazon customer', status: 'open', customer_first_name: 'Chris', customer_last_name: null, customer_email: null, customer_phone: null, customer_address: null, refund_issued: null, approved_repair_price: null, order_id: '204-8021934-0768344' }
const env: any = { OPENAI_API_KEY: 'test', OPENAI_BASE_URL: 'http://stub.local/v1' }
const thread: any[] = [{ direction: 'inbound', body: 'Can I keep the phone for a £50 partial refund, or please send a returns label?', sent_at: '2026-11-15T12:50:57Z', sender: 'Chris', kind: 'message', id: 1 }]
const draft = 'Dear Chris,\n\nThank you for the photos. We have also noted your request for a £50 partial refund if you keep the phone. We will share the feedback from our technician once the phone is checked.\n\nKind regards,\nCustomer Support Team'
let calls: any[] = []
const stub = (answer: any) => { calls = []; (globalThis as any).fetch = async (_u: string, init: any) => { calls.push(JSON.parse(init.body)); if (answer instanceof Error) throw answer; return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(answer) } }] }) } } }

test('word checks fire on this RIQ-1225 draft (the starting point)', () => {
  const rules = serverChecks(draft, kase).map((f) => f.rule).sort()
  assert.deepEqual(rules, ['never_reviews', 'refund_over_15'])
})

test('model says neither applies → both cleared, nothing open', async () => {
  stub({ never_reviews: { applies: false, why: '"for review" means the team will look into it' }, refund_over_15: { applies: false, why: 'only notes the customer asked for £50; no offer' } })
  const out = await reviewInContext(env, kase, thread, [], draft, serverChecks(draft, kase))
  assert.equal(openFindings(out).length, 0)
  assert.equal(out.filter((f) => f.severity === 'cleared').length, 2)
  assert.equal(calls.length, 1, 'one model call for both rules')
  assert.equal(calls[0].store, false)
})

test('model says it applies → finding stays', async () => {
  stub({ never_reviews: { applies: true, why: 'asks for a review' }, refund_over_15: { applies: false, why: 'no offer' } })
  const out = await reviewInContext(env, kase, thread, [], draft, serverChecks(draft, kase))
  assert.deepEqual(openFindings(out).map((f) => f.rule), ['never_reviews'])
})

test('model unreachable or malformed → findings unchanged (fail-safe)', async () => {
  stub(new Error('network down'))
  assert.equal(openFindings(await reviewInContext(env, kase, thread, [], draft, serverChecks(draft, kase))).length, 2)
  stub({ something_else: true })
  assert.equal(openFindings(await reviewInContext(env, kase, thread, [], draft, serverChecks(draft, kase))).length, 2)
})

test('word-only rules never go to the model and are never cleared', async () => {
  stub({})
  const d2 = 'Dear Chris,\n\nThis does not affect your statutory rights.\n\nKind regards,\nCustomer Support Team'
  const out = await reviewInContext(env, kase, thread, [], d2, serverChecks(d2, kase))
  assert.equal(calls.length, 0)
  assert.ok(openFindings(out).some((f) => f.rule === 'never_statutory_rights'))
})

test('a clearance only applies to the exact text it was made for', async () => {
  stub({ never_reviews: { applies: false, why: 'x' }, refund_over_15: { applies: false, why: 'y' } })
  const stored = await reviewInContext(env, kase, thread, [], draft, serverChecks(draft, kase))
  assert.equal(applyCleared(serverChecks(draft, kase), stored, draft).length, 0)
  const edited = draft.replace('once the phone is checked.', 'once the phone is checked. Please leave us a review.')
  assert.ok(applyCleared(serverChecks(edited, kase), stored, edited).some((f) => f.rule === 'never_reviews'))
})

test('safety warning: cleared when the phone is already back with us, kept otherwise', async () => {
  const k2: any = { ...kase, battery_flag: true }
  const d3 = 'Dear Chris,\n\nWe understand you are asking for a further £30 reduction. We are unable to increase the refund amount further.\n\nKind regards,\nCustomer Support Team'
  assert.ok(serverChecks(d3, k2).some((f) => f.rule === 'safety_stop_using' && f.severity === 'fail'))
  stub({ safety_stop_using: { applies: false, why: 'customer said the device has arrived at your location' }, price_unapproved: { applies: false, why: 'the £30 is the customer request' } })
  const out = await reviewInContext(env, k2, thread, [], d3, serverChecks(d3, k2))
  assert.deepEqual(openFindings(out).map((f) => f.rule), [])
  stub(new Error('down'))
  assert.ok(openFindings(await reviewInContext(env, k2, thread, [], d3, serverChecks(d3, k2))).some((f) => f.rule === 'safety_stop_using'))
})
