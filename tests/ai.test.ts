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

// ───────── "statutory rights" wording is banned (Sagar) ─────────
const failsStatutory = (text: string, mode: 'customer' | 'seller_central_atoz' = 'customer') =>
  serverChecks(text, kase, mode).filter((f) => f.rule === 'never_statutory_rights')
const sign = '\n\nKind regards,\nCustomer Support Team'
test('"your statutory rights" fails the draft check', () => {
  const f = failsStatutory('Dear Sam,\n\nThank you for your message. This is in line with Amazon\'s policies and your statutory rights.' + sign)
  assert.equal(f.length, 1); assert.equal(f[0].severity, 'fail')
})
test('"statutory", "consumer rights" and "legal rights" all fail, in any case and in Amazon statements too', () => {
  for (const t of ['Your Statutory Rights are unaffected.', 'We respect your consumer rights.', 'Nothing affects your legal right to a remedy, or your legal rights.', 'This is a statutory matter.', 'Under the Consumer Rights Act we will help.'])
    assert.equal(failsStatutory(`Dear Sam,\n\n${t}${sign}`).length, 1, t)
  assert.equal(failsStatutory('The customer cited their statutory rights.', 'seller_central_atoz').length, 1)
})
test('a normal "through Amazon / in line with Amazon policies" reply does NOT trip the new check', () => {
  assert.equal(failsStatutory('Dear Sam,\n\nThank you for your message. We will review this in line with Amazon\'s policies once the phone has been returned and inspected.' + sign).length, 0)
  assert.equal(failsStatutory('Dear Sam,\n\nWe have raised this through Amazon and will update you.' + sign).length, 0)
})
test('the knowledge base and templates cannot carry the wording back in', async () => {
  const { validateRuleText } = await import('../src/kb')
  assert.ok(validateRuleText('Always add: in line with Amazon policies and your statutory rights.').some((p) => /statutory/i.test(p)))
  assert.ok(validateRuleText('Mention the customer\'s consumer rights when they complain.').some((p) => /statutory|consumer/i.test(p)))
  assert.deepEqual(validateRuleText('Use through Amazon wording only for refund eligibility and warranty outcome.'), [])
})
test('the policy file, the seed and the decision tree no longer use or recommend the wording', async () => {
  const { readFileSync } = await import('node:fs')
  const policy = readFileSync('reply_instructions.md', 'utf8')
  assert.match(policy, /Never mention statutory rights, consumer rights or legal rights/)
  assert.doesNotMatch(policy.replace(/Never mention statutory rights, consumer rights or legal rights[\s\S]*?next steps instead:/, ''), /statutory/i)
  assert.doesNotMatch(readFileSync('db/migrations/0014_templates_and_kb_seed.sql', 'utf8'), /statutory/i)
  assert.doesNotMatch(readFileSync('public/static/app.js', 'utf8').replace(/Mention statutory, consumer or legal rights[^']*/, '').replace(/\(statutory\|consumer rights\?\|legal rights\?\)/, ''), /statutory/i)
})
