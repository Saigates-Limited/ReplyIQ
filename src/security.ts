// Security controls promised in the Amazon SP-API data protection review (Tax Invoicing role, 20 Nov 2026):
//  - passwords: 12+ characters with upper, lower, number and special character; changed every 365 days
//  - TOTP multi-factor authentication for every user (RFC 6238, 30 s, 6 digits, SHA-1 — what authenticator apps use)
//  - security_log: logins, failed logins, MFA events, password changes, every buyer-address lookup
//  - buyer personal data removed 30 days after a case closes; VAT invoices kept 6 years, then deleted
import type { Sql } from './db'

export const PASSWORD_MAX_AGE_DAYS = 365
export const LOCK_AFTER_FAILS = 5
export const LOCK_MINUTES = 10
export const PII_RETENTION_DAYS = 30
export const INVOICE_RETENTION_YEARS = 6

/** null when the password meets the policy, otherwise what is wrong (shown to the user). */
export function passwordProblem(pw: string): string | null {
  const p = String(pw ?? '')
  const missing: string[] = []
  if (p.length < 12) missing.push('at least 12 characters')
  if (!/[a-z]/.test(p)) missing.push('a lower-case letter')
  if (!/[A-Z]/.test(p)) missing.push('an upper-case letter')
  if (!/\d/.test(p)) missing.push('a number')
  if (!/[^A-Za-z0-9]/.test(p)) missing.push('a special character')
  return missing.length ? `Password needs ${missing.join(', ')}.` : null
}

export const passwordExpired = (changedAt: Date | string | null | undefined, now = new Date()) =>
  !changedAt || now.getTime() - new Date(changedAt).getTime() > PASSWORD_MAX_AGE_DAYS * 86400_000

// ───────── TOTP ─────────
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = ''
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5 }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}
export function base32Decode(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '')
  let bits = 0, value = 0
  const out: number[] = []
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch); bits += 5
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8 }
  }
  return new Uint8Array(out)
}
export const newTotpSecret = () => base32Encode(crypto.getRandomValues(new Uint8Array(20)))

export async function hotp(secret: string, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', base32Decode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const msg = new Uint8Array(8)
  let c = counter
  for (let i = 7; i >= 0; i--) { msg[i] = c & 255; c = Math.floor(c / 256) }
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg))
  const o = h[h.length - 1] & 15
  const bin = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]
  return String(bin % 1_000_000).padStart(6, '0')
}

/** The time step the code matches (allowing one step of clock drift either way), or null. */
export async function verifyTotp(secret: string, code: string, now = Date.now(), lastStep?: number | null): Promise<number | null> {
  const c = String(code ?? '').replace(/\s/g, '')
  if (!/^\d{6}$/.test(c)) return null
  const step = Math.floor(now / 30_000)
  for (const s of [step, step - 1, step + 1]) {
    if (lastStep != null && s <= Number(lastStep)) continue // a code can only be used once
    if ((await hotp(secret, s)) === c) return s
  }
  return null
}

export const otpauthUrl = (secret: string, email: string) =>
  `otpauth://totp/${encodeURIComponent('ReplyIQ:' + email)}?secret=${secret}&issuer=ReplyIQ&algorithm=SHA1&digits=6&period=30`

// ───────── Security log ─────────
export type SecurityEvent =
  | 'login' | 'login_failed' | 'login_locked' | 'mfa_failed' | 'mfa_enabled' | 'mfa_reset' | 'logout'
  | 'password_changed' | 'password_reset_by_manager' | 'user_created' | 'user_deactivated' | 'user_reactivated' | 'role_changed'
  | 'buyer_address_lookup' | 'invoice_opened' | 'invoice_deleted' | 'pii_purge'

export async function logSecurity(sql: Sql, e: { event: SecurityEvent; user_id?: number | null; email?: string | null; ip?: string | null; detail?: Record<string, unknown> }) {
  try {
    await sql`INSERT INTO security_log (event, user_id, email, ip, detail)
              VALUES (${e.event}, ${e.user_id ?? null}, ${e.email ?? null}, ${e.ip ?? null}, ${sql.json((e.detail ?? {}) as any)})`
  } catch (err) {
    console.error('security_log write failed', e.event, err) // never block the request on the log
  }
}

export const clientIp = (c: { req: { header: (n: string) => string | undefined } }) =>
  c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || null

// ───────── 30-day buyer data clean-up ─────────
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Remove a buyer's known details plus anything that looks like an email, phone, postcode or street line. */
export function scrubText(text: string | null | undefined, k: { first?: string | null; last?: string | null; email?: string | null; phone?: string | null; address?: string | null },
  patterns: (t: string) => string): string | null {
  if (text == null) return text ?? null
  let out = String(text)
  const known = [
    k.first && k.last ? `${k.first} ${k.last}` : null,
    k.last, k.email, k.phone, k.address,
    ...(k.address ? k.address.split(/[,\n]/).map((p) => p.trim()).filter((p) => p.length > 3) : []),
  ].filter((v): v is string => !!v && v.trim().length > 1)
  for (const v of known.sort((a, b) => b.length - a.length)) out = out.replace(new RegExp(escapeRe(v.trim()), 'gi'), '[removed]')
  // First names on their own only in greetings / sign-offs, so a name like "Will" or "May" elsewhere stays readable.
  if (k.first && k.first.trim().length > 1) {
    const f = escapeRe(k.first.trim())
    out = out.replace(new RegExp(`\\b(Dear|Hi|Hello|Hey|Thanks|Thank you|Regards|Best|Cheers),?\\s+${f}\\b`, 'gi'), '$1 [removed]')
    out = out.replace(new RegExp(`(^|\\n)\\s*${f}\\s*$`, 'gim'), '$1[removed]')
  }
  return patterns(out)
}

export type PurgeResult = { cases: number; invoices_deleted: number; ids: number[] }

/**
 * Cases that are closed (resolved or archived), with nothing open (A-to-Z, chargeback, return) and no customer message
 * for 30 days: blank the buyer's name and contact details and scrub them from every stored text. Then delete VAT
 * invoices past the 6-year retention period. Idempotent; runs daily from the scheduled handler.
 */
export async function purgeBuyerData(sql: Sql, patterns: (t: string) => string, opts: { now?: Date; limit?: number } = {}): Promise<PurgeResult> {
  const now = opts.now ?? new Date()
  const cutoff = new Date(now.getTime() - PII_RETENTION_DAYS * 86400_000)
  const due = await sql`
    SELECT c.id, c.internal_notes, c.customer_first_name, c.customer_last_name, c.customer_email, c.customer_phone, c.customer_address
    FROM cases c
    WHERE c.pii_purged_at IS NULL
      AND (c.status = 'resolved' OR c.archived_at IS NOT NULL)
      AND c.last_customer_message_at < ${cutoff}
      AND NOT COALESCE(c.a_to_z_open, false) AND NOT COALESCE(c.chargeback_open, false)
      AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.case_id = c.id AND m.sent_at >= ${cutoff})
      AND NOT EXISTS (SELECT 1 FROM amazon_events e WHERE e.case_id = c.id AND e.status = 'open')
      AND NOT EXISTS (SELECT 1 FROM returns r WHERE r.case_id = c.id AND r.status <> 'closed')
    ORDER BY c.id LIMIT ${opts.limit ?? 200}`
  const ids: number[] = []
  for (const c of due as any[]) {
    const k = { first: c.customer_first_name, last: c.customer_last_name, email: c.customer_email, phone: c.customer_phone, address: c.customer_address }
    const s = (t: string | null) => scrubText(t, k, patterns)
    await sql.begin(async (tx: any) => {
      for (const m of await tx`SELECT id, body FROM messages WHERE case_id = ${c.id}`)
        { const b = s(m.body)!; if (b !== m.body) await tx`UPDATE messages SET body = ${b} WHERE id = ${m.id}` }
      for (const d of await tx`SELECT id, draft_text, original_text FROM drafts WHERE case_id = ${c.id}`)
        await tx`UPDATE drafts SET draft_text = ${s(d.draft_text) ?? ''}, original_text = ${s(d.original_text) ?? ''} WHERE id = ${d.id}`
      for (const e of await tx`SELECT id, customer_comment, response_text, raw_excerpt FROM amazon_events WHERE case_id = ${c.id}`)
        await tx`UPDATE amazon_events SET customer_comment = ${s(e.customer_comment)}, response_text = ${s(e.response_text)}, raw_excerpt = ${s(e.raw_excerpt)} WHERE id = ${e.id}`
      for (const r of await tx`SELECT id, customer_comment, notes FROM returns WHERE case_id = ${c.id}`)
        await tx`UPDATE returns SET customer_comment = ${s(r.customer_comment)}, notes = ${s(r.notes)}, legacy_customer_name = NULL WHERE id = ${r.id}`
      for (const cm of await tx`SELECT m.id, m.body FROM carrier_messages m JOIN carrier_cases cc ON cc.id = m.carrier_case_id WHERE cc.case_id = ${c.id}`)
        { const b = s(cm.body)!; if (b !== cm.body) await tx`UPDATE carrier_messages SET body = ${b} WHERE id = ${cm.id}` }
      for (const cd of await tx`SELECT d.id, d.body, d.original_body FROM carrier_drafts d JOIN carrier_cases cc ON cc.id = d.carrier_case_id WHERE cc.case_id = ${c.id}`)
        await tx`UPDATE carrier_drafts SET body = ${s(cd.body) ?? ''}, original_body = ${s(cd.original_body) ?? ''} WHERE id = ${cd.id}`
      await tx`DELETE FROM case_overviews WHERE case_id = ${c.id}`
      await tx`DELETE FROM draft_files WHERE case_id = ${c.id}`
      await tx`UPDATE cases SET customer_first_name = 'Customer', customer_last_name = NULL, customer_email = NULL,
                 customer_phone = NULL, customer_address = NULL, customer_reply_to = NULL, internal_notes = ${s(c.internal_notes)},
                 pii_purged_at = ${now} WHERE id = ${c.id}`
    })
    ids.push(c.id)
  }
  const old = await sql`DELETE FROM invoices WHERE created_at < ${new Date(now.getTime() - INVOICE_RETENTION_YEARS * 365.25 * 86400_000)} RETURNING id`
  if (ids.length || old.length)
    await logSecurity(sql, { event: 'pii_purge', detail: { cases: ids.length, case_ids: ids.slice(0, 50), invoices_deleted: old.length } })
  return { cases: ids.length, invoices_deleted: old.length, ids }
}
