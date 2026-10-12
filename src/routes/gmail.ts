import { Hono } from 'hono'
import { getDb, type Bindings } from '../db'
import { requireManager, type Vars } from '../auth'
import { authUrl, exchangeCode, encryptToken, decryptToken, revokeToken, getProfile, getConnection, accessToken, sendReply, requireGoogleConfig, GMAIL_SCOPES } from '../gmail'
import { runSync } from '../sync'
import { serverChecks, type CaseRow } from '../ai'

// Protected (mounted behind requireAuth)
export const gmailApi = new Hono<{ Bindings: Bindings; Variables: Vars }>()

const origin = (url: string) => new URL(url).origin

// GET /api/gmail/status
gmailApi.get('/status', async (c) => {
  const sql = getDb(c.env)
  try {
    const conn = await getConnection(sql)
    const runs = await sql`SELECT id, started_at, finished_at, trigger, threads_seen, messages_new, cases_new, status, error FROM sync_runs ORDER BY started_at DESC LIMIT 10`
    let configured = true, configError: string | null = null
    try { requireGoogleConfig(c.env) } catch (e: any) { configured = false; configError = e.message }
    return c.json({
      configured, configError,
      connected: Boolean(conn),
      connection: conn ? { ...conn, refresh_token_enc: undefined } : null,
      poll_interval_minutes: 15,
      scopes: GMAIL_SCOPES,
      recent_runs: runs,
    })
  } finally {
    await sql.end()
  }
})

// POST /api/gmail/connect  (manager) → returns Google consent URL
gmailApi.post('/connect', requireManager, async (c) => {
  requireGoogleConfig(c.env)
  const state = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('')
  const sql = getDb(c.env)
  try {
    await sql`DELETE FROM oauth_states WHERE created_at < now() - INTERVAL '15 minutes'`
    await sql`INSERT INTO oauth_states (state, user_id) VALUES (${state}, ${c.get('user').id})`
  } finally {
    await sql.end()
  }
  return c.json({ url: authUrl(c.env, origin(c.req.url), state) })
})

// POST /api/gmail/disconnect (manager)
gmailApi.post('/disconnect', requireManager, async (c) => {
  const sql = getDb(c.env)
  try {
    const conn = await getConnection(sql)
    if (conn) {
      try { await revokeToken(await decryptToken(c.env, conn.refresh_token_enc)) } catch {}
      await sql`DELETE FROM gmail_connection WHERE id = 1`
    }
    return c.json({ ok: true })
  } finally {
    await sql.end()
  }
})

// POST /api/gmail/sync  (any staff) → run the poller now (1-hour window)
// POST /api/gmail/sync {days: 7|30|90}  (manager) → one-off history import
gmailApi.post('/sync', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { days?: number }
  const days = [7, 30, 90].includes(Number(body.days)) ? Number(body.days) : 0
  if (days && c.get('user').role !== 'manager') return c.json({ error: 'Only a manager can import history' }, 403)
  const sql = getDb(c.env)
  try {
    const result = await runSync(c.env, sql, days ? 'import' : 'manual', days ? { lookbackDays: days } : {})
    return c.json({ ok: true, ...result })
  } catch (e: any) {
    return c.json({ error: e.message }, 502)
  } finally {
    await sql.end()
  }
})

export const sendApi = new Hono<{ Bindings: Bindings; Variables: Vars }>()
// POST /api/drafts/:id/send — the ONLY place in the system that sends email.
// Gates: approved status, manager approval honoured, text unchanged since approval, server checks clean,
// one send per draft, Gmail-sourced case with a reply-to address.
sendApi.post('/drafts/:id/send', async (c) => {
  const id = Number(c.req.param('id'))
  const user = c.get('user')
  const body = (await c.req.json().catch(() => ({}))) as { confirm_text?: string }
  const sql = getDb(c.env)
  try {
    const [d] = await sql`SELECT * FROM drafts WHERE id = ${id}`
    if (!d) return c.json({ error: 'Draft not found' }, 404)
    if (d.status === 'sent') return c.json({ error: 'This draft has already been sent' }, 409)
    if (d.status !== 'approved') return c.json({ error: 'Only approved drafts can be sent' }, 403)
    if (d.needs_manager && !d.approved_by) return c.json({ error: 'Manager approval missing' }, 403)
    if ((body.confirm_text ?? '').trim() !== String(d.draft_text).trim())
      return c.json({ error: 'The text on screen differs from the approved draft. Reload and try again.' }, 409)

    const [kase] = await sql<CaseRow[]>`SELECT * FROM cases WHERE id = ${d.case_id}`
    if (!kase.gmail_thread_id || !kase.customer_reply_to) return c.json({ error: 'This case did not come from Gmail, so it cannot be sent from here. Use "Mark as sent" after sending in Amazon.' }, 400)
    const fails = serverChecks(d.draft_text, kase).filter((f) => f.severity === 'fail')
    if (fails.length) return c.json({ error: 'Draft fails checks: ' + fails.map((f) => f.detail).join('; ') }, 422)

    const [lastInbound] = await sql`SELECT subject, rfc_message_id FROM messages WHERE case_id = ${kase.id} AND direction = 'inbound' ORDER BY sent_at DESC LIMIT 1`
    const refs = await sql`SELECT rfc_message_id FROM messages WHERE case_id = ${kase.id} AND rfc_message_id IS NOT NULL ORDER BY sent_at ASC`
    const subject = lastInbound?.subject ? (/^re:/i.test(lastInbound.subject) ? lastInbound.subject : `Re: ${lastInbound.subject}`) : `Re: ${kase.subject}`

    // Atomically claim the send so two clicks cannot both go out
    const claimed = await sql`UPDATE drafts SET status = 'sending', updated_at = now() WHERE id = ${id} AND status = 'approved' RETURNING id`
    if (!claimed.length) return c.json({ error: 'Draft is already being sent' }, 409)

    try {
      const { token, conn } = await accessToken(c.env, sql)
      const sent = await sendReply(token, {
        from: conn.email_address,
        to: kase.customer_reply_to,
        subject,
        body: d.draft_text,
        inReplyTo: lastInbound?.rfc_message_id || undefined,
        references: refs.map((r) => r.rfc_message_id).join(' ') || undefined,
        threadId: kase.gmail_thread_id,
      })
      await sql.begin(async (tx) => {
        await tx`UPDATE drafts SET status = 'sent', sent_via = 'gmail', sent_gmail_message_id = ${sent.id}, sent_recorded_by = ${user.id}, sent_recorded_at = now(), updated_at = now() WHERE id = ${id}`
        await tx`INSERT INTO messages (case_id, direction, sender, body, subject, gmail_message_id, sent_at)
                 VALUES (${kase.id}, 'outbound', ${'Saigates Support (' + user.name + ')'}, ${d.draft_text}, ${subject}, ${sent.id}, now())`
        await tx`UPDATE cases SET status = 'awaiting_customer', updated_at = now() WHERE id = ${kase.id} AND status = 'open'`
      })
      return c.json({ ok: true, gmail_message_id: sent.id })
    } catch (e: any) {
      await sql`UPDATE drafts SET status = 'approved', updated_at = now() WHERE id = ${id} AND status = 'sending'`
      return c.json({ error: `Send failed: ${e.message}` }, 502)
    }
  } finally {
    await sql.end()
  }
})

// ───────── Public callback (mounted BEFORE requireAuth; state ties it to a logged-in manager) ─────────
export const gmailCallback = new Hono<{ Bindings: Bindings }>()
gmailCallback.get('/auth/google/callback', async (c) => {
  const url = new URL(c.req.url)
  const code = url.searchParams.get('code'), state = url.searchParams.get('state'), err = url.searchParams.get('error')
  const back = (msg: string, ok = false) => c.redirect(`/gmail?${ok ? 'ok' : 'error'}=${encodeURIComponent(msg)}`)
  if (err) return back(`Google returned: ${err}`)
  if (!code || !state) return back('Missing code or state')
  const sql = getDb(c.env)
  try {
    const [st] = await sql`DELETE FROM oauth_states WHERE state = ${state} AND created_at > now() - INTERVAL '15 minutes' RETURNING user_id`
    if (!st) return back('Login link expired or invalid. Please try Connect again.')
    const [u] = await sql`SELECT role FROM users WHERE id = ${st.user_id} AND is_active`
    if (u?.role !== 'manager') return back('Only a manager can connect Gmail.')

    const tok = await exchangeCode(c.env, url.origin, code)
    if (!tok.refresh_token) return back('Google did not return a refresh token. Remove ReplyIQ at myaccount.google.com/permissions and try again.')
    const granted = tok.scope.split(' ')
    const missing = GMAIL_SCOPES.filter((s) => !granted.includes(s))
    if (missing.length) return back(`Missing permission: ${missing.map((s) => s.split('/').pop()).join(', ')}. Please tick all boxes on the Google screen.`)
    const profile = await getProfile(tok.access_token)
    const enc = await encryptToken(c.env, tok.refresh_token)
    await sql`
      INSERT INTO gmail_connection (id, email_address, refresh_token_enc, scopes, connected_by)
      VALUES (1, ${profile.emailAddress}, ${enc}, ${tok.scope}, ${st.user_id})
      ON CONFLICT (id) DO UPDATE SET email_address = EXCLUDED.email_address, refresh_token_enc = EXCLUDED.refresh_token_enc,
        scopes = EXCLUDED.scopes, connected_by = EXCLUDED.connected_by, connected_at = now(), last_sync_status = NULL, last_sync_error = NULL`
    return back(`Connected ${profile.emailAddress}`, true)
  } catch (e: any) {
    return back(e.message)
  } finally {
    await sql.end()
  }
})
