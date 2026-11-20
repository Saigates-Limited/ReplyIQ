// Security controls for the Amazon Tax Invoicing review: password policy, TOTP, scrubbing buyer data.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { passwordProblem, passwordExpired, base32Encode, base32Decode, hotp, verifyTotp, scrubText, otpauthUrl } from '../src/security'

test('password policy: 12+ with upper, lower, number, special', () => {
  assert.equal(passwordProblem('Short1!'), 'Password needs at least 12 characters.')
  assert.match(passwordProblem('alllowercase123!')!, /upper-case/)
  assert.match(passwordProblem('NoNumbersHere!!')!, /number/)
  assert.match(passwordProblem('NoSpecials12345')!, /special/)
  assert.equal(passwordProblem('Saigates-2026-ok'), null)
})

test('password expires after 365 days', () => {
  const now = new Date('2026-11-20T12:00:00Z')
  assert.equal(passwordExpired(new Date('2026-01-01T00:00:00Z'), now), false)
  assert.equal(passwordExpired(new Date('2025-11-19T00:00:00Z'), now), true)
  assert.equal(passwordExpired(null, now), true)
})

test('TOTP matches RFC 6238 SHA-1 test vectors (last 6 digits)', async () => {
  const secret = base32Encode(new TextEncoder().encode('12345678901234567890'))
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
  assert.deepEqual([...base32Decode(secret)], [...new TextEncoder().encode('12345678901234567890')])
  assert.equal(await hotp(secret, Math.floor(59 / 30)), '287082')
  assert.equal(await hotp(secret, Math.floor(1111111109 / 30)), '081804')
  assert.equal(await hotp(secret, Math.floor(1234567890 / 30)), '005924')
})

test('TOTP: accepts ±30 s drift, rejects reuse and wrong codes', async () => {
  const secret = base32Encode(new TextEncoder().encode('12345678901234567890'))
  const t = 1111111109_000
  const code = await hotp(secret, Math.floor(t / 30000))
  const step = await verifyTotp(secret, code, t)
  assert.equal(step, Math.floor(t / 30000))
  assert.equal(await verifyTotp(secret, code, t + 30_000), step, 'one step late still works')
  assert.equal(await verifyTotp(secret, code, t, step), null, 'same code twice is refused')
  assert.equal(await verifyTotp(secret, '000000', t), null)
  assert.equal(await verifyTotp(secret, 'abc', t), null)
  assert.match(otpauthUrl(secret, 'a@b.com'), /^otpauth:\/\/totp\/ReplyIQ%3Aa%40b\.com\?secret=GEZ/)
})

test('scrubText removes the buyer, keeps the conversation readable', () => {
  const k = { first: 'Ivan', last: 'Petrov', email: 'ivan.p@example.com', phone: '07700 900123', address: '12 Mill Lane, Bilston, WV14 0AB' }
  const pat = (t: string) => t.replace(/\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/g, '[postcode redacted]')
  const out = scrubText('Dear Ivan,\nIvan Petrov here, 12 Mill Lane, Bilston WV14 0AB. Call 07700 900123 or ivan.p@example.com. Will it arrive?\nIvan', k, pat)!
  assert.ok(!/Ivan|Petrov|Mill Lane|Bilston|900123|example\.com|WV14/.test(out), out)
  assert.match(out, /^Dear \[removed\],/)
  assert.match(out, /Will it arrive\?/)
  assert.equal(scrubText(null, k, pat), null)
})
