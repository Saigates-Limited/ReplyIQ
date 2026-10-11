import { Hono } from 'hono'
import { getDb, type Bindings } from '../db'
import { createSession, destroySession, hashPassword, verifyPassword, requireManager, type Vars } from '../auth'

// Public: login/logout (mounted before the auth guard)
export const authPublic = new Hono<{ Bindings: Bindings; Variables: Vars }>()
// Protected: me / password / staff management (mounted after the auth guard)
export const authApi = new Hono<{ Bindings: Bindings; Variables: Vars }>()

// Very small in-isolate rate limiter for login attempts (per email).
const attempts = new Map<string, { n: number; until: number }>()
function throttled(email: string) {
  const a = attempts.get(email)
  return a && a.n >= 5 && a.until > Date.now()
}
function recordFail(email: string) {
  const a = attempts.get(email) ?? { n: 0, until: 0 }
  a.n++
  if (a.n >= 5) a.until = Date.now() + 10 * 60_000
  attempts.set(email, a)
}

authPublic.post('/login', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { email?: string; password?: string }
  const email = String(body.email ?? '').trim().toLowerCase()
  const password = String(body.password ?? '')
  if (!email || !password) return c.json({ error: 'Email and password are required' }, 400)
  if (throttled(email)) return c.json({ error: 'Too many attempts. Try again in 10 minutes.' }, 429)

  const sql = getDb(c.env)
  let user: any
  try {
    ;[user] = await sql`SELECT id, email, name, role, password_hash, is_active FROM users WHERE email = ${email}`
  } finally {
    await sql.end()
  }
  const ok = user && user.is_active && (await verifyPassword(password, user.password_hash))
  if (!ok) {
    recordFail(email)
    return c.json({ error: 'Invalid email or password' }, 401)
  }
  attempts.delete(email)
  await createSession(c, user.id)
  return c.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } })
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
  if (password.length < 12) return c.json({ error: 'Password must be at least 12 characters' }, 400)
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
    await createSession(c, rows[0].id)
    return c.json({ ok: true }, 201)
  } finally {
    await sql.end()
  }
})

authPublic.post('/logout', async (c) => {
  await destroySession(c)
  return c.json({ ok: true })
})

authApi.get('/me', (c) => c.json({ user: c.get('user') }))

// Change own password
authApi.post('/password', async (c) => {
  const { current, next } = (await c.req.json().catch(() => ({}))) as { current?: string; next?: string }
  if (!current || !next || next.length < 10) return c.json({ error: 'New password must be at least 10 characters' }, 400)
  const sql = getDb(c.env)
  try {
    const [row] = await sql`SELECT password_hash FROM users WHERE id = ${c.get('user').id}`
    if (!(await verifyPassword(current, row.password_hash))) return c.json({ error: 'Current password is incorrect' }, 401)
    await sql`UPDATE users SET password_hash = ${await hashPassword(next)} WHERE id = ${c.get('user').id}`
    return c.json({ ok: true })
  } finally {
    await sql.end()
  }
})

// ───────── Staff management (managers only) ─────────
authApi.get('/users', requireManager, async (c) => {
  const sql = getDb(c.env)
  try {
    const users = await sql`SELECT id, email, name, role, is_active, created_at, last_login_at FROM users ORDER BY name`
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
  if (password.length < 10) return c.json({ error: 'Password must be at least 10 characters' }, 400)
  const sql = getDb(c.env)
  try {
    const [u] = await sql`INSERT INTO users (email, name, role, password_hash) VALUES (${email}, ${name}, ${role}, ${await hashPassword(password)})
                          RETURNING id, email, name, role, is_active, created_at`
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
  const b = (await c.req.json().catch(() => ({}))) as { role?: string; is_active?: boolean; password?: string; name?: string }
  const me = c.get('user')
  if (id === me.id && (b.role === 'agent' || b.is_active === false)) return c.json({ error: 'You cannot demote or deactivate yourself' }, 400)
  const sql = getDb(c.env)
  try {
    if (b.role) await sql`UPDATE users SET role = ${b.role === 'manager' ? 'manager' : 'agent'} WHERE id = ${id}`
    if (typeof b.is_active === 'boolean') {
      await sql`UPDATE users SET is_active = ${b.is_active} WHERE id = ${id}`
      if (!b.is_active) await sql`DELETE FROM sessions WHERE user_id = ${id}`
    }
    if (b.name) await sql`UPDATE users SET name = ${String(b.name).trim()} WHERE id = ${id}`
    if (b.password) {
      if (b.password.length < 10) return c.json({ error: 'Password must be at least 10 characters' }, 400)
      await sql`UPDATE users SET password_hash = ${await hashPassword(b.password)} WHERE id = ${id}`
      await sql`DELETE FROM sessions WHERE user_id = ${id}`
    }
    const [u] = await sql`SELECT id, email, name, role, is_active, created_at, last_login_at FROM users WHERE id = ${id}`
    if (!u) return c.json({ error: 'User not found' }, 404)
    return c.json({ user: u })
  } finally {
    await sql.end()
  }
})
