// Staff authentication: PBKDF2 password hashing (Web Crypto, Workers-safe)
// + opaque session tokens in an HttpOnly cookie.
import type { Context, MiddlewareHandler } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { getDb, type Bindings } from './db'

export type Role = 'agent' | 'manager'
export type User = { id: number; email: string; name: string; role: Role }
export type Vars = { user: User }

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

export async function createSession(c: Context<{ Bindings: Bindings }>, userId: number) {
  const token = randomToken()
  const id = await sha256Hex(token)
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000)
  const sql = getDb(c.env)
  try {
    await sql`INSERT INTO sessions (id, user_id, expires_at) VALUES (${id}, ${userId}, ${expires})`
    await sql`UPDATE users SET last_login_at = now() WHERE id = ${userId}`
  } finally {
    await sql.end()
  }
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    expires,
  })
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

export async function getSessionUser(c: Context<{ Bindings: Bindings }>): Promise<User | null> {
  const token = getCookie(c, COOKIE)
  if (!token) return null
  const sql = getDb(c.env)
  try {
    const rows = await sql<User[]>`
      SELECT u.id, u.email, u.name, u.role
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ${await sha256Hex(token)} AND s.expires_at > now() AND u.is_active`
    return rows[0] ?? null
  } finally {
    await sql.end()
  }
}

/** Blocks every request unless a valid session exists. API → 401 JSON, pages → redirect to /login. */
export const requireAuth: MiddlewareHandler<{ Bindings: Bindings; Variables: Vars }> = async (c, next) => {
  const user = await getSessionUser(c)
  if (!user) {
    if (c.req.path.startsWith('/api/')) return c.json({ error: 'Authentication required' }, 401)
    const next = encodeURIComponent(c.req.path)
    return c.redirect(`/login?next=${next}`)
  }
  c.set('user', user)
  await next()
}

export const requireManager: MiddlewareHandler<{ Bindings: Bindings; Variables: Vars }> = async (c, next) => {
  if (c.get('user')?.role !== 'manager') return c.json({ error: 'Manager role required' }, 403)
  await next()
}
