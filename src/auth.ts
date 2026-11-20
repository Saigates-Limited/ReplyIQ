// Staff authentication: PBKDF2 password hashing (Web Crypto, Workers-safe)
// + opaque session tokens in an HttpOnly cookie.
import type { Context, MiddlewareHandler } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { getDb, type Bindings } from './db'

export type Role = 'agent' | 'manager'
export type User = { id: number; email: string; name: string; role: Role }
export type Stage = 'full' | 'mfa_verify' | 'mfa_setup' | 'password_change'
export type Vars = { user: User; stage: Stage }

const COOKIE = 'riq_session'
const SESSION_DAYS = 7
const PBKDF2_ITER = 100_000

const enc = new TextEncoder()
const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)))
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITER }, key, 256)
  return `pbkdf2$${PBKDF2_ITER}$${b64(salt.buffer)}$${b64(bits)}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterStr, saltB64, hashB64] = stored.split('$')
  if (scheme !== 'pbkdf2') return false
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: unb64(saltB64), iterations: Number(iterStr) },
    key,
    256
  )
  const a = new Uint8Array(bits), b = unb64(hashB64)
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

async function sha256Hex(s: string) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s))
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return [...bytes].map((x) => x.toString(16).padStart(2, '0')).join('')
}

// A session that has passed the password but not yet MFA / a required password change lives 15 minutes and can
// only reach the sign-in step endpoints (STEP_PATHS). Only a 'full' session reaches the app.
const STEP_MINUTES = 15
const expiryFor = (stage: Stage) => new Date(Date.now() + (stage === 'full' ? SESSION_DAYS * 86400_000 : STEP_MINUTES * 60_000))

export async function createSession(c: Context<{ Bindings: Bindings }>, userId: number, stage: Stage = 'full') {
  const token = randomToken()
  const id = await sha256Hex(token)
  const expires = expiryFor(stage)
  const sql = getDb(c.env)
  try {
    await sql`INSERT INTO sessions (id, user_id, expires_at, stage) VALUES (${id}, ${userId}, ${expires}, ${stage})`
    if (stage === 'full') await sql`UPDATE users SET last_login_at = now() WHERE id = ${userId}`
  } finally {
    await sql.end()
  }
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    expires: new Date(Date.now() + SESSION_DAYS * 86400_000),
  })
}

/** Move the current session to the next sign-in stage (same cookie). */
export async function setSessionStage(c: Context<{ Bindings: Bindings }>, stage: Stage) {
  const token = getCookie(c, COOKIE)
  if (!token) return
  const sql = getDb(c.env)
  try {
    const [s] = await sql`UPDATE sessions SET stage = ${stage}, expires_at = ${expiryFor(stage)} WHERE id = ${await sha256Hex(token)} RETURNING user_id`
    if (s && stage === 'full') await sql`UPDATE users SET last_login_at = now() WHERE id = ${s.user_id}`
  } finally {
    await sql.end()
  }
}

export async function destroySession(c: Context<{ Bindings: Bindings }>) {
  const token = getCookie(c, COOKIE)
  if (token) {
    const sql = getDb(c.env)
    try {
      await sql`DELETE FROM sessions WHERE id = ${await sha256Hex(token)}`
    } finally {
      await sql.end()
    }
  }
  deleteCookie(c, COOKIE, { path: '/' })
}

export async function getSession(c: Context<{ Bindings: Bindings }>): Promise<{ user: User; stage: Stage } | null> {
  const token = getCookie(c, COOKIE)
  if (!token) return null
  const sql = getDb(c.env)
  try {
    const rows = await sql<(User & { stage: Stage })[]>`
      SELECT u.id, u.email, u.name, u.role, s.stage
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ${await sha256Hex(token)} AND s.expires_at > now() AND u.is_active`
    if (!rows[0]) return null
    const { stage, ...user } = rows[0]
    return { user, stage: stage ?? 'full' }
  } finally {
    await sql.end()
  }
}

/** The signed-in user, only once every sign-in step (password, MFA, password change) is complete. */
export async function getSessionUser(c: Context<{ Bindings: Bindings }>): Promise<User | null> {
  const s = await getSession(c)
  return s && s.stage === 'full' ? s.user : null
}

// Endpoints a part-signed-in session may call.
const STEP_PATHS = ['/api/auth/me', '/api/auth/mfa/setup', '/api/auth/mfa/enable', '/api/auth/mfa/verify', '/api/auth/password']

/** Blocks every request unless a valid session exists. API → 401 JSON, pages → redirect to /login. */
export const requireAuth: MiddlewareHandler<{ Bindings: Bindings; Variables: Vars }> = async (c, next) => {
  const s = await getSession(c)
  if (!s) {
    if (c.req.path.startsWith('/api/')) return c.json({ error: 'Authentication required' }, 401)
    const next = encodeURIComponent(c.req.path)
    return c.redirect(`/login?next=${next}`)
  }
  if (s.stage !== 'full' && !STEP_PATHS.includes(c.req.path)) {
    if (c.req.path.startsWith('/api/')) return c.json({ error: 'Finish signing in first', code: 'auth_step', stage: s.stage }, 403)
    return c.redirect(`/login?next=${encodeURIComponent(c.req.path)}`)
  }
  c.set('user', s.user)
  c.set('stage', s.stage)
  await next()
}

export const requireManager: MiddlewareHandler<{ Bindings: Bindings; Variables: Vars }> = async (c, next) => {
  if (c.get('user')?.role !== 'manager') return c.json({ error: 'Manager role required' }, 403)
  await next()
}
