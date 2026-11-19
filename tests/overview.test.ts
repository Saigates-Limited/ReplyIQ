// AI Overview timeline: built from records; the model only adds one-line gists.
import { test } from 'node:test'
import assert from 'node:assert/strict'
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
const { buildTimeline, sourceMarker } = await import('../src/overview')

const kase: any = { customer_first_name: 'Rhandee', delivery_date: '2026-10-20T00:00:00Z', delivery_date_source: 'amazon_actual' }
const order = { orderDate: '2026-10-18T09:00:00Z', shipDate: '2026-10-19T08:00:00Z', grandTotal: '129.00', currency: 'GBP', items: [{ title: 'Apple iPhone XR, 64GB, Black (Renewed)' }] }
const msgs: any[] = [
  { id: 1, direction: 'inbound', kind: 'message', sender: 'Customer', body: 'The battery has been defective. It doesnt last for half a day', sent_at: '2026-11-10T06:44:15Z' },
  { id: 2, direction: 'outbound', kind: 'seller_central_copy', sender: 'Saigates Support (via Seller Central)', body: 'Dear Rhandee, please check battery health...', sent_at: '2026-11-10T09:59:04Z' },
  { id: 3, direction: 'inbound', kind: 'event', sender: 'ReplyIQ', body: 'Reopened: the customer wrote again after the case was resolved.', sent_at: '2026-11-17T16:23:30Z' },
  { id: 4, direction: 'inbound', kind: 'event', sender: 'Amazon', body: 'Return requested ...', sent_at: '2026-11-12T10:00:00Z' },
  { id: 5, direction: 'outbound', kind: 'message', sender: 'Saigates Support (Kuldeep)', body: 'Dear Rhandee, thank you...', sent_at: '2026-11-17T16:21:53Z' },
]
const events: any[] = [{ kind: 'return_request', status: 'requested', amount: null, currency: null, received_at: '2026-11-12T10:00:00Z', return_reason: 'Defective', customer_comment: 'Battery drains by lunchtime' }]

test('timeline in date order with order, Amazon, messages and ReplyIQ notes', () => {
  const t = buildTimeline(kase, msgs, events, order, new Map([[1, 'Battery lasts under half a day']]))
  assert.deepEqual(t.map((x) => x.type), ['order', 'order', 'order', 'customer', 'us', 'amazon', 'us', 'note'])
  assert.equal(t[0].detail, 'Apple iPhone XR, 64GB, Black (Renewed) · £129.00')
  assert.equal(t[3].label, 'Battery lasts under half a day') // model gist used
  assert.equal(t[3].who, 'Rhandee')
  assert.equal(t[4].who, 'via Seller Central')
  assert.equal(t[6].who, 'Kuldeep')
  assert.match(t[5].detail!, /Defective/)
  assert.ok(!t.some((x) => /Return requested \.\.\./.test(x.label))) // Amazon notice messages not duplicated
})

test('without the model, messages fall back to an excerpt', () => {
  const t = buildTimeline(kase, msgs, [], null, new Map())
  assert.equal(t.find((x) => x.type === 'customer')!.label, 'The battery has been defective. It doesnt last for half a day')
})

test('cache marker changes when a message arrives', () => {
  assert.notEqual(sourceMarker(msgs), sourceMarker([...msgs, { id: 6 }]))
})
