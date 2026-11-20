import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { getDb, type Bindings } from '../db'
import { createSession, destroySession, hashPassword, verifyPassword, requireManager, setSessionStage, getSession, type Vars, type Stage } from '../auth'
import { encryptToken, decryptToken } from '../gmail'
import { passwordProblem, passwordExpired, newTotpSecret, otpauthUrl, verifyTotp, logSecurity, clientIp, LOCK_AFTER_FAILS, LOCK_MINUTES } from '../security'

// Public: login/logout (mounted before the auth guard)
export const authPublic = new Hono<{ Bindings: Bindings; Variables: Vars }>()
// Protected: me / password / staff management (mounted after the auth guard)
export const authApi = new Hono<{ Bindings: Bindings; Variables: Vars }>()

// Lockout is kept in the database (failed_logins / locked_until) so it holds across Worker isolates.
type LoginRow = { id: number; email: string; name: string; role: string; password_hash: string; is_active: boolean
  failed_logins: number; locked_until: Date | null; totp_enabled_at: Date | null; password_changed_at: Date | null; password_must_change: boolean }

async function recordFailure(sql: any, c: any, u: { id: number; email: string }, event: 'login_failed' | 'mfa_failed') {
  const [r] = await sql`UPDATE users SET failed_logins = failed_logins + 1,
                          locked_until = CASE WHEN failed_logins + 1 >= ${LOCK_AFTER_FAILS} THEN now() + make_interval(mins => ${LOCK_MINUTES}) ELSE locked_until END
                        WHERE id = ${u.id} RETURNING failed_logins, locked_until`
  await logSecurity(sql, { event, user_id: u.id, email: u.email, ip: clientIp(c), detail: { failed_logins: r?.failed_logins } })
  if (r && r.failed_logins >= LOCK_AFTER_FAILS) await logSecurity(sql, { event: 'login_locked', user_id: u.id, email: u.email, ip: clientIp(c) })
}
const locked = (u: { locked_until: Date | null }) => !!u.locked_until && new Date(u.locked_until).getTime() > Date.now()
const LOCKED_MSG = `Too many attempts. Try again in ${LOCK_MINUTES} minutes.`

/** After MFA: a weak, temporary or year-old password must be changed before the app opens. */
const afterMfa = (u: { password_changed_at: Date | null; password_must_change: boolean }): Stage =>
  u.password_must_change || passwordExpired(u.password_changed_at) ? 'password_change' : 'full'

authPublic.post('/login', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { email?: string; password?: string }
  const email = String(body.email ?? '').trim().toLowerCase()
  const password = String(body.password ?? '')
  if (!email || !password) return c.json({ error: 'Email and password are required' }, 400)

  const sql = getDb(c.env)
  try {
    const [user] = await sql<LoginRow[]>`SELECT id, email, name, role, password_hash, is_active, failed_logins, locked_until,
                                           totp_enabled_at, password_changed_at, password_must_change FROM users WHERE email = ${email}`
    if (!user) {
      // Same lockout as a real account, so the answer never shows whether an email has an account (pen test 20 Nov 2026).
      const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM security_log WHERE event = 'login_failed' AND email = ${email}
                                AND at > now() - make_interval(mins => ${LOCK_MINUTES})`
      if (n >= LOCK_AFTER_FAILS) return c.json({ error: LOCKED_MSG }, 429)
      await logSecurity(sql, { event: 'login_failed', email, ip: clientIp(c), detail: { reason: 'unknown_email' } })
      return c.json({ error: 'Invalid email or password' }, 401)
    }
    if (locked(user)) return c.json({ error: LOCKED_MSG }, 429)
    if (!user.is_active || !(await verifyPassword(password, user.password_hash))) {
      await recordFailure(sql, c, user, 'login_failed')
      return c.json({ error: 'Invalid email or password' }, 401)
    }
    // Password right. A password that no longer meets the policy is flagged so it must be changed after MFA.
    if (passwordProblem(password) && !user.password_must_change) {
      await sql`UPDATE users SET password_must_change = true WHERE id = ${user.id}`
      user.password_must_change = true
    }
    const stage: Stage = user.totp_enabled_at ? 'mfa_verify' : 'mfa_setup'
    await createSession(c, user.id, stage)
    return c.json({ next: stage, user: { id: user.id, email: user.email, name: user.name, role: user.role } })
  } finally {
    await sql.end()
  }
})

// ───────── Multi-factor authentication (authenticator app) ─────────
// Step 1 for a user without MFA: a new secret to scan. Kept encrypted (AES-256-GCM, TOKEN_ENC_KEY) and unused until confirmed.
authApi.post('/mfa/setup', async (c) => {
  if (c.get('stage') !== 'mfa_setup') return c.json({ error: 'MFA is already set up for this account' }, 409)
  const me = c.get('user')
  const secret = newTotpSecret()
  const sql = getDb(c.env)
  try {
    await sql`UPDATE users SET totp_secret_enc = ${await encryptToken(c.env, secret)} WHERE id = ${me.id} AND totp_enabled_at IS NULL`
    return c.json({ secret, otpauth: otpauthUrl(secret, me.email) })
  } finally {
    await sql.end()
  }
})

async function checkCode(c: any, sql: any, enable: boolean) {
  const me = c.get('user')
  const code = String(((await c.req.json().catch(() => ({}))) as any).code ?? '')
  const [u] = await sql`SELECT id, email, totp_secret_enc, totp_last_step, failed_logins, locked_until, password_changed_at, password_must_change
                        FROM users WHERE id = ${me.id}`
  if (!u?.totp_secret_enc) return c.json({ error: 'Start MFA setup first' }, 400)
  if (locked(u)) return c.json({ error: LOCKED_MSG }, 429)
  const step = await verifyTotp(await decryptToken(c.env, u.totp_secret_enc), code, Date.now(), u.totp_last_step)
  if (step == null) {
    await recordFailure(sql, c, u, 'mfa_failed')
    return c.json({ error: 'That code is not right. Check the 6-digit code in your authenticator app and try again.' }, 401)
  }
  await sql`UPDATE users SET totp_last_step = ${step}, failed_logins = 0, locked_until = NULL
            ${enable ? sql`, totp_enabled_at = now()` : sql``} WHERE id = ${u.id}`
  if (enable) await logSecurity(sql, { event: 'mfa_enabled', user_id: u.id, email: u.email, ip: clientIp(c) })
  const next = afterMfa(u)
  await setSessionStage(c, next)
  if (next === 'full') await logSecurity(sql, { event: 'login', user_id: u.id, email: u.email, ip: clientIp(c) })
  return c.json({ next })
}
authApi.post('/mfa/enable', async (c) => {
  if (c.get('stage') !== 'mfa_setup') return c.json({ error: 'Not in MFA setup' }, 409)
  const sql = getDb(c.env)
  try { return await checkCode(c, sql, true) } finally { await sql.end() }
})
authApi.post('/mfa/verify', async (c) => {
  if (c.get('stage') !== 'mfa_verify') return c.json({ error: 'No sign-in code is needed now' }, 409)
  const sql = getDb(c.env)
  try { return await checkCode(c, sql, false) } finally { await sql.end() }
})

// First-run: create the first manager. Only works while the users table is empty,
// so it is impossible to use once any account exists.
authPublic.get('/setup-status', async (c) => {
  const sql = getDb(c.env)
  try {
    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM users`
    return c.json({ needs_setup: n === 0 })
  } finally {
    await sql.end()
  }
})

authPublic.post('/setup', async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { email?: string; name?: string; password?: string }
  const email = String(b.email ?? '').trim().toLowerCase()
  const name = String(b.name ?? '').trim()
  const password = String(b.password ?? '')
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.json({ error: 'Valid email required' }, 400)
  if (!name) return c.json({ error: 'Name required' }, 400)
  const weak = passwordProblem(password)
  if (weak) return c.json({ error: weak }, 400)
  const sql = getDb(c.env)
  try {
    const hash = await hashPassword(password)
    // Atomic: insert only if the table is still empty.
    const rows = await sql`
      INSERT INTO users (email, name, role, password_hash)
      SELECT ${email}, ${name}, 'manager', ${hash}
      WHERE NOT EXISTS (SELECT 1 FROM users)
      RETURNING id`
    if (!rows.length) return c.json({ error: 'Setup has already been completed' }, 409)
    await logSecurity(sql, { event: 'user_created', user_id: rows[0].id, email, ip: clientIp(c), detail: { role: 'manager', first_run: true } })
    await createSession(c, rows[0].id, 'mfa_setup')
    return c.json({ ok: true, next: 'mfa_setup' }, 201)
  } finally {
    await sql.end()
  }
})

authPublic.post('/logout', async (c) => {
  const s = await getSession(c).catch(() => null)
  if (s?.stage === 'full') { const sql = getDb(c.env); try { await logSecurity(sql, { event: 'logout', user_id: s.user.id, email: s.user.email, ip: clientIp(c) }) } finally { await sql.end() } }
  await destroySession(c)
  return c.json({ ok: true })
})

authApi.get('/me', async (c) => {
  const me = c.get('user')
  if (c.get('stage') !== 'full') return c.json({ user: me, stage: c.get('stage') })
  const sql = getDb(c.env)
  try {
    const [u] = await sql`SELECT password_changed_at, totp_enabled_at FROM users WHERE id = ${me.id}`
    const days = u?.password_changed_at ? 365 - Math.floor((Date.now() - new Date(u.password_changed_at).getTime()) / 86400_000) : 0
    return c.json({ user: me, stage: 'full', password_days_left: days, mfa: !!u?.totp_enabled_at })
  } finally {
    await sql.end()
  }
})

// Change own password
authApi.post('/password', async (c) => {
  const { current, next } = (await c.req.json().catch(() => ({}))) as { current?: string; next?: string }
  if (!current || !next) return c.json({ error: 'Enter your current and new password' }, 400)
  const weak = passwordProblem(next)
  if (weak) return c.json({ error: weak }, 400)
  if (current === next) return c.json({ error: 'The new password must be different from the current one' }, 400)
  const me = c.get('user')
  const sql = getDb(c.env)
  try {
    const [row] = await sql`SELECT password_hash FROM users WHERE id = ${me.id}`
    if (!(await verifyPassword(current, row.password_hash))) return c.json({ error: 'Current password is incorrect' }, 401)
    await sql`UPDATE users SET password_hash = ${await hashPassword(next)}, password_changed_at = now(), password_must_change = false WHERE id = ${me.id}`
    await logSecurity(sql, { event: 'password_changed', user_id: me.id, email: me.email, ip: clientIp(c) })
    // Sign out every other device; this one carries on (or finishes signing in).
    const token = getCookie(c, 'riq_session')
    if (token) await sql`DELETE FROM sessions WHERE user_id = ${me.id} AND id <> ${await sha256(token)}`
    if (c.get('stage') === 'password_change') {
      await setSessionStage(c, 'full')
      await logSecurity(sql, { event: 'login', user_id: me.id, email: me.email, ip: clientIp(c) })
    }
    return c.json({ ok: true, next: 'full' })
  } finally {
    await sql.end()
  }
})

// ───────── Staff management (managers only) ─────────
authApi.get('/users', requireManager, async (c) => {
  const sql = getDb(c.env)
  try {
    const users = await sql`SELECT id, email, name, role, is_active, created_at, last_login_at, password_changed_at, totp_enabled_at IS NOT NULL AS mfa FROM users ORDER BY name`
    return c.json({ users })
  } finally {
    await sql.end()
  }
})

authApi.post('/users', requireManager, async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { email?: string; name?: string; role?: string; password?: string }
  const email = String(b.email ?? '').trim().toLowerCase()
  const name = String(b.name ?? '').trim()
  const role = b.role === 'manager' ? 'manager' : 'agent'
  const password = String(b.password ?? '')
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.json({ error: 'Valid email required' }, 400)
  if (!name) return c.json({ error: 'Name required' }, 400)
  const weak = passwordProblem(password)
  if (weak) return c.json({ error: weak }, 400)
  const sql = getDb(c.env)
  try {
    // A password set by a manager is temporary: the new user sets up MFA and then chooses their own.
    const [u] = await sql`INSERT INTO users (email, name, role, password_hash, password_must_change) VALUES (${email}, ${name}, ${role}, ${await hashPassword(password)}, true)
                          RETURNING id, email, name, role, is_active, created_at`
    await logSecurity(sql, { event: 'user_created', user_id: u.id, email: u.email, ip: clientIp(c), detail: { role, by: c.get('user').id } })
    return c.json({ user: u }, 201)
  } catch (e: any) {
    if (String(e.message).includes('duplicate')) return c.json({ error: 'A user with that email already exists' }, 409)
    throw e
  } finally {
    await sql.end()
  }
})

authApi.patch('/users/:id', requireManager, async (c) => {
  const id = Number(c.req.param('id'))
  const b = (await c.req.json().catch(() => ({}))) as { role?: string; is_active?: boolean; password?: string; name?: string; reset_mfa?: boolean }
  const me = c.get('user')
  if (id === me.id && (b.role === 'agent' || b.is_active === false)) return c.json({ error: 'You cannot demote or deactivate yourself' }, 400)
  const sql = getDb(c.env)
  try {
    const [target] = await sql`SELECT email FROM users WHERE id = ${id}`
    if (!target) return c.json({ error: 'User not found' }, 404)
    const log = (event: any, detail: Record<string, unknown> = {}) => logSecurity(sql, { event, user_id: id, email: target.email, ip: clientIp(c), detail: { ...detail, by: me.id } })
    if (b.password) {
      const weak = passwordProblem(b.password)
      if (weak) return c.json({ error: weak }, 400)
    }
    if (b.role) { await sql`UPDATE users SET role = ${b.role === 'manager' ? 'manager' : 'agent'} WHERE id = ${id}`; await log('role_changed', { role: b.role }) }
    if (typeof b.is_active === 'boolean') {
      await sql`UPDATE users SET is_active = ${b.is_active} WHERE id = ${id}`
      if (!b.is_active) await sql`DELETE FROM sessions WHERE user_id = ${id}`
      await log(b.is_active ? 'user_reactivated' : 'user_deactivated')
    }
    if (b.name) await sql`UPDATE users SET name = ${String(b.name).trim()} WHERE id = ${id}`
    if (b.password) {
      await sql`UPDATE users SET password_hash = ${await hashPassword(b.password)}, password_must_change = true, failed_logins = 0, locked_until = NULL WHERE id = ${id}`
      await sql`DELETE FROM sessions WHERE user_id = ${id}`
      await log('password_reset_by_manager')
    }
    if (b.reset_mfa) {
      if (id === me.id) return c.json({ error: 'Ask another manager to reset your own MFA' }, 400)
      await sql`UPDATE users SET totp_secret_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL WHERE id = ${id}`
      await sql`DELETE FROM sessions WHERE user_id = ${id}`
      await log('mfa_reset')
    }
    const [u] = await sql`SELECT id, email, name, role, is_active, created_at, last_login_at, password_changed_at, totp_enabled_at IS NOT NULL AS mfa FROM users WHERE id = ${id}`
    if (!u) return c.json({ error: 'User not found' }, 404)
    return c.json({ user: u })
  } finally {
    await sql.end()
  }
})

// ───────── Security log (managers) ─────────
authApi.get('/security-log', requireManager, async (c) => {
  const event = c.req.query('event') || null
  const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') || 200)))
  const sql = getDb(c.env)
  try {
    const rows = await sql`SELECT l.id, l.at, l.event, l.email, l.ip, l.detail, u.name AS user_name
                           FROM security_log l LEFT JOIN users u ON u.id = l.user_id
                           WHERE (${event}::text IS NULL OR l.event = ${event}) ORDER BY l.at DESC LIMIT ${limit}`
    const [counts] = await sql`SELECT
        COUNT(*) FILTER (WHERE event = 'login_failed' AND at > now() - interval '7 days')::int AS failed_7d,
        COUNT(*) FILTER (WHERE event = 'buyer_address_lookup' AND at > now() - interval '7 days')::int AS address_7d,
        COUNT(*) FILTER (WHERE event = 'login_locked' AND at > now() - interval '7 days')::int AS locked_7d,
        MAX(at) FILTER (WHERE event = 'pii_purge') AS last_purge
      FROM security_log`
    return c.json({ rows, counts })
  } finally {
    await sql.end()
  }
})

async function sha256(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('')
}
