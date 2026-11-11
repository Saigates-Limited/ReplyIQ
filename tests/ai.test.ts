// serverChecks / redactPii vs IMEIs. ai.ts imports reply_instructions.md with ?raw (a Vite feature), so register a tiny loader first.
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
const { serverChecks, redactPii } = await import('../src/ai')

const kase: any = { customer_first_name: 'Sam', customer_last_name: 'Jones', customer_email: null, customer_phone: null, customer_address: null,
  approved_repair_price: null, repair_quote_accepted: null, refund_issued: false, battery_flag: false, delivery_date: null, device_model: 'iPhone 13' }

function imeis(n: number) {
  let seed = 12345
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  return Array.from({ length: n }, () => { let f = ''; for (let i = 0; i < 14; i++) f += Math.floor(rnd() * 10); return f + imeiCheckDigit(f) })
}

test('a 15-digit IMEI never fails the draft checker (no false "Repeats a phone number")', () => {
  for (const imei of imeis(500)) {
    const fails = serverChecks(`Hi Sam, your replacement phone has IMEI ${imei}. Kind regards`, kase).filter((f) => f.severity === 'fail')
    assert.deepEqual(fails, [], imei)
  }
})

test('a real phone number still fails the checker, even next to an IMEI', () => {
  const fails = serverChecks('Your IMEI is 356938035643809. Call 07700 900123 to confirm.', kase).filter((f) => f.rule === 'pii')
  assert.equal(fails.length, 1)
})

test('IMEIs survive redactPii; phone numbers do not', () => {
  for (const imei of imeis(500)) assert.ok(redactPii(`IMEI ${imei}`, kase).includes(imei), imei)
  assert.match(redactPii('ring me on 07700 900123', kase), /\[phone redacted\]/)
})
