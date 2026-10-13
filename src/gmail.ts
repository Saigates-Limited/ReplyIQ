// Gmail integration: OAuth 2.0, encrypted refresh-token storage, read threads, send replies.
// Scopes: gmail.readonly (poller) + gmail.send (human-initiated Send button only).
import type { Bindings, Sql } from './db'

export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send']
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const API = 'https://gmail.googleapis.com/gmail/v1/users/me'

export const redirectUri = (origin: string) => `${origin}/auth/google/callback`

export function requireGoogleConfig(env: Bindings) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not configured')
  if (!env.TOKEN_ENC_KEY) throw new Error('TOKEN_ENC_KEY is not configured')
}

// ───────────── Token encryption (AES-256-GCM, key from TOKEN_ENC_KEY secret) ─────────────
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u))
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

async function aesKey(env: Bindings) {
  const raw = unb64(env.TOKEN_ENC_KEY!)
  if (raw.length !== 32) throw new Error('TOKEN_ENC_KEY must be 32 bytes, base64-encoded')
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}
export async function encryptToken(env: Bindings, plaintext: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), new TextEncoder().encode(plaintext)))
  const out = new Uint8Array(iv.length + ct.length)
  out.set(iv); out.set(ct, iv.length)
  return b64(out)
}
export async function decryptToken(env: Bindings, enc: string) {
  const buf = unb64(enc)
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, await aesKey(env), buf.slice(12))
  return new TextDecoder().decode(pt)
}

// ───────────── OAuth ─────────────
export function authUrl(env: Bindings, origin: string, state: string) {
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri(origin),
    response_type: 'code',
    scope: GMAIL_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent', // force a refresh token every time
    include_granted_scopes: 'true',
    state,
  })
  return `${AUTH_URL}?${p}`
}

export async function exchangeCode(env: Bindings, origin: string, code: string) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri(origin),
      grant_type: 'authorization_code',
    }),
  })
  const data: any = await res.json()
  if (!res.ok) throw new Error(`Google token exchange failed: ${data.error_description || data.error || res.status}`)
  return data as { access_token: string; refresh_token?: string; scope: string; expires_in: number }
}

async function refreshAccessToken(env: Bindings, refreshToken: string) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      grant_type: 'refresh_token',
    }),
  })
  const data: any = await res.json()
  if (!res.ok) throw new Error(`Google token refresh failed: ${data.error_description || data.error || res.status}`)
  return data.access_token as string
}

export async function revokeToken(token: string) {
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' }).catch(() => {})
}

// ───────────── Connection record ─────────────
export type GmailConnection = {
  id: number
  label: string
  enabled: boolean
  is_default: boolean
  email_address: string
  refresh_token_enc: string
  scopes: string
  connected_at: string
  last_sync_at: string | null
  last_sync_status: string | null
  last_sync_error: string | null
  last_sync_new_msgs: number | null
  connected_by_name?: string | null
}

// Multi-mailbox (migration 0013). Before it, gmail_connection is a single row (id=1) without label/enabled/is_default;
// the queries below tolerate that so the app keeps working until the migration is applied.
let multiKnown: boolean | null = null
export async function hasMultiMailbox(sql: Sql) {
  if (multiKnown !== null) return multiKnown
  const [r] = await sql`SELECT 1 FROM information_schema.columns WHERE table_name = 'gmail_connection' AND column_name = 'label'`
  multiKnown = !!r
  return multiKnown
}
const CONN_COLS = (multi: boolean) =>
  multi ? `g.id, g.label, g.enabled, g.is_default` : `g.id, 'Mailbox'::text AS label, TRUE AS enabled, TRUE AS is_default`

/** All connected mailboxes, default first. */
export async function listConnections(sql: Sql): Promise<GmailConnection[]> {
  const multi = await hasMultiMailbox(sql)
  return sql.unsafe(`
    SELECT ${CONN_COLS(multi)}, g.email_address, g.refresh_token_enc, g.scopes, g.connected_at, g.last_sync_at, g.last_sync_status, g.last_sync_error, g.last_sync_new_msgs,
           u.name AS connected_by_name
    FROM gmail_connection g LEFT JOIN users u ON u.id = g.connected_by
    ORDER BY ${multi ? 'g.is_default DESC,' : ''} g.id ASC`) as unknown as Promise<GmailConnection[]>
}

/** One mailbox by id; with no id → the default mailbox (or the only/first one). */
export async function getConnection(sql: Sql, mailboxId?: number | null): Promise<GmailConnection | null> {
  const all = await listConnections(sql)
  if (mailboxId != null) return all.find((c) => c.id === mailboxId) ?? null
  return all.find((c) => c.is_default) ?? all[0] ?? null
}

/** Live access token for a mailbox. With no id → the default mailbox. */
export async function accessToken(env: Bindings, sql: Sql, mailboxId?: number | null) {
  requireGoogleConfig(env)
  const conn = await getConnection(sql, mailboxId)
  if (!conn) throw new Error(mailboxId != null ? `Mailbox #${mailboxId} is no longer connected` : 'Gmail is not connected')
  return { token: await refreshAccessToken(env, await decryptToken(env, conn.refresh_token_enc)), conn }
}

// ───────────── Gmail API ─────────────
export class GmailQuotaError extends Error {
  constructor(msg: string) { super(msg); this.name = 'GmailQuotaError' }
}
const isQuota = (status: number, txt: string) => status === 429 || (status === 403 && /quota|rateLimitExceeded|userRateLimitExceeded/i.test(txt))

/** Gmail REST call. Per-user quota bursts (403 "Units per minute per user" / 429) are retried with backoff
 *  (2s, 4s, 8s — ~14s total, within the Worker's time budget); if still limited, a GmailQuotaError is thrown
 *  so the caller can stop cleanly and resume later instead of failing the whole run. Read-only GETs and the
 *  idempotent send (threadId-scoped) are safe to retry; a 429 means the request was not processed. */
async function gapi<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  let lastTxt = ''
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${API}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } })
    if (res.ok) return res.json() as Promise<T>
    lastTxt = await res.text()
    if (!isQuota(res.status, lastTxt) || attempt === 3) {
      if (isQuota(res.status, lastTxt)) throw new GmailQuotaError(`Gmail rate limit reached (per-minute quota). Progress is saved; it resumes automatically on the next sync or when you press Sync again in a minute.`)
      throw new Error(`Gmail API ${res.status} on ${path.split('?')[0]}: ${lastTxt.slice(0, 200)}`)
    }
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt))
  }
  throw new Error(`Gmail API error: ${lastTxt.slice(0, 200)}`)
}

export const getProfile = (token: string) => gapi<{ emailAddress: string }>(token, '/profile')

export async function listThreadIds(token: string, q: string, max = 50) {
  const ids: string[] = []
  let pageToken: string | undefined
  do {
    const p = new URLSearchParams({ q, maxResults: String(Math.min(max - ids.length, 100)) })
    if (pageToken) p.set('pageToken', pageToken)
    const data = await gapi<{ threads?: { id: string }[]; nextPageToken?: string }>(token, `/threads?${p}`)
    for (const t of data.threads ?? []) ids.push(t.id)
    pageToken = data.nextPageToken
  } while (pageToken && ids.length < max)
  return ids
}

export type GmailHeader = { name: string; value: string }
export type GmailPart = { partId?: string; mimeType: string; filename?: string; body?: { data?: string; size?: number; attachmentId?: string }; parts?: GmailPart[]; headers?: GmailHeader[] }
export type GmailMessage = {
  id: string
  threadId: string
  internalDate: string // ms since epoch, set by Google on arrival
  labelIds?: string[]
  snippet?: string
  payload: GmailPart
}
export const getMessage = (token: string, id: string) => gapi<GmailMessage>(token, `/messages/${id}?format=full`)
export const getThread = (token: string, id: string) =>
  gapi<{ id: string; messages: GmailMessage[] }>(token, `/threads/${id}?format=full`)

export const header = (m: GmailMessage, name: string) =>
  m.payload.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''

function decodeB64Url(s: string) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  return new TextDecoder('utf-8').decode(bytes)
}

/** Prefer text/plain; fall back to stripped text/html. */
export function messageBody(m: GmailMessage): string {
  let plain = '', html = ''
  const walk = (p: GmailPart) => {
    if (p.mimeType === 'text/plain' && p.body?.data && !plain) plain = decodeB64Url(p.body.data)
    else if (p.mimeType === 'text/html' && p.body?.data && !html) html = decodeB64Url(p.body.data)
    p.parts?.forEach(walk)
  }
  walk(m.payload)
  if (plain.trim()) return plain
  return html
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ───────────── Send (human-initiated only) ─────────────
function encodeHeaderUtf8(v: string) {
  return /[^\x20-\x7e]/.test(v) ? `=?UTF-8?B?${btoa(unescape(encodeURIComponent(v)))}?=` : v
}

export async function sendReply(
  token: string,
  args: { from: string; to: string; subject: string; body: string; inReplyTo?: string; references?: string; threadId: string }
) {
  const lines = [
    `From: Saigates Customer Care <${args.from}>`,
    `To: ${args.to}`,
    `Subject: ${encodeHeaderUtf8(args.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ]
  if (args.inReplyTo) lines.push(`In-Reply-To: ${args.inReplyTo}`)
  if (args.references) lines.push(`References: ${args.references}`)
  const bodyB64 = btoa(unescape(encodeURIComponent(args.body))).replace(/(.{76})/g, '$1\r\n')
  const raw = lines.join('\r\n') + '\r\n\r\n' + bodyB64
  const rawUrl = btoa(unescape(encodeURIComponent(raw))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return gapi<{ id: string; threadId: string }>(token, '/messages/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: rawUrl, threadId: args.threadId }),
  })
}

/** Attachment parts of a message (anything with a filename and an attachmentId). Inline images included. */
export function listAttachments(m: GmailMessage) {
  const out: { attachmentId: string; filename: string; mimeType: string; size: number; inline: boolean }[] = []
  const walk = (p: GmailPart) => {
    if (p.filename && p.body?.attachmentId) {
      const disp = p.headers?.find((h) => h.name.toLowerCase() === 'content-disposition')?.value ?? ''
      out.push({ attachmentId: p.body.attachmentId, filename: p.filename, mimeType: p.mimeType || 'application/octet-stream', size: p.body.size ?? 0, inline: /inline/i.test(disp) })
    }
    p.parts?.forEach(walk)
  }
  walk(m.payload)
  return out
}

/** Fetch attachment bytes from Gmail (gmail.readonly scope). Returned as a Uint8Array. */
export async function getAttachment(token: string, messageId: string, attachmentId: string): Promise<Uint8Array> {
  const data = await gapi<{ data: string; size: number }>(token, `/messages/${messageId}/attachments/${attachmentId}`)
  const bin = atob(data.data.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}
