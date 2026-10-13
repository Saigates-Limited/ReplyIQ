import { Hono } from 'hono'
import { getDb, type Bindings } from '../db'
import { requireManager, type Vars } from '../auth'
import { authUrl, exchangeCode, encryptToken, decryptToken, revokeToken, getProfile, getConnection, accessToken, sendReply, requireGoogleConfig, GMAIL_SCOPES } from '../gmail'
import { runSync, backfillAttachments } from '../sync'
import { serverChecks, redactPii, type CaseRow } from '../ai'
import { classifyTone } from '../tone'
import { getAttachment, getMessage } from '../gmail'
import { AMAZON_ATTACHMENT_RULES, checkAttachments } from '../attachments'

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
    // Google client health probe (managers): shape of the client ID + Google's verdict. Values are never returned.
    let client_probe: any = null
    if (c.get('user').role === 'manager' && c.req.query('probe') === '1') {
      const id = c.env.GOOGLE_CLIENT_ID || ''
      const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: id, client_secret: c.env.GOOGLE_CLIENT_SECRET || '', refresh_token: 'probe', grant_type: 'refresh_token' }) })
      const j: any = await r.json().catch(() => ({}))
      // invalid_grant  => client exists (only the token is bad)  |  invalid_client => client deleted / wrong project / typo
      client_probe = {
        client_id_suffix: id.slice(-30), client_id_length: id.length, looks_like_google_id: /\.apps\.googleusercontent\.com$/.test(id),
        secret_length: (c.env.GOOGLE_CLIENT_SECRET || '').length,
        google_error: j.error ?? null, google_description: j.error_description ?? null,
        verdict: j.error === 'invalid_grant' ? 'client OK' : j.error === 'invalid_client' ? 'client NOT recognised by Google' : `unexpected (${r.status})`,
      }
    }
    return c.json({
      configured, configError,
      connected: Boolean(conn),
      connection: conn ? { ...conn, refresh_token_enc: undefined } : null,
      poll_interval_minutes: 15,
      scopes: GMAIL_SCOPES,
      recent_runs: runs,
      client_probe,
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

// POST /api/gmail/tone-backfill {limit?} (manager) → label existing customer messages that have no tone yet.
// Runs in batches of up to 20 per call (OpenAI subrequests); call repeatedly until remaining = 0.
gmailApi.post('/tone-backfill', requireManager, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { limit?: number }
  const limit = Math.min(Math.max(Number(body.limit) || 20, 1), 20)
  const sql = getDb(c.env)
  try {
    const rows = await sql<any[]>`
      SELECT c.*, m.id AS message_id, m.case_id, m.body AS message_body, m.sent_at AS message_sent_at
      FROM messages m JOIN cases c ON c.id = m.case_id
      WHERE m.direction = 'inbound' AND m.kind <> 'event' AND m.tone IS NULL
      ORDER BY m.sent_at DESC LIMIT ${limit}`
    let labelled = 0
    for (const r of rows) {
      const kase = { ...r, id: r.case_id } as CaseRow
      const res = await classifyTone(c.env, redactPii(String(r.message_body), kase)).catch(() => null)
      if (!res) continue
      await sql`UPDATE messages SET tone = ${res.label}, tone_source = 'ai', tone_model = ${res.model} WHERE id = ${r.message_id} AND tone IS NULL`
      await sql`UPDATE cases SET tone = ${res.label}, updated_at = now() WHERE id = ${r.case_id}
                AND ${r.message_id} = (SELECT id FROM messages WHERE case_id = ${r.case_id} AND direction = 'inbound' AND kind <> 'event' ORDER BY sent_at DESC LIMIT 1)`
      labelled++
    }
    const [{ remaining }] = await sql`SELECT COUNT(*)::int AS remaining FROM messages WHERE direction = 'inbound' AND kind <> 'event' AND tone IS NULL`
    return c.json({ ok: true, labelled, remaining })
  } finally {
    await sql.end()
  }
})

// POST /api/gmail/attachment-backfill (manager) — one-off after migration 0009; call until remaining = 0
gmailApi.post('/attachment-backfill', requireManager, async (c) => {
  const sql = getDb(c.env)
  try { return c.json({ ok: true, ...(await backfillAttachments(c.env, sql)) }) }
  catch (e: any) { return c.json({ error: e.message }, 502) }
  finally { await sql.end() }
})

// GET /api/gmail/messages/:id/structure (manager) — MIME structure of one stored message: part types, filenames,
// sizes and link hosts only. No body text or file content. Used to diagnose how a client sent its photos.
gmailApi.get('/messages/:id/structure', requireManager, async (c) => {
  const id = Number(c.req.param('id'))
  const sql = getDb(c.env)
  try {
    const [m] = await sql`SELECT gmail_message_id FROM messages WHERE id = ${id}`
    if (!m?.gmail_message_id) return c.json({ error: 'No Gmail message for this id' }, 404)
    const token = await accessToken(c.env, sql)
    const gm = await getMessage(token, m.gmail_message_id)
    const parts: any[] = []
    const walk = (p: any, depth: number) => {
      parts.push({ depth, mimeType: p.mimeType, filename: p.filename || null, size: p.body?.size ?? null, hasAttachmentId: !!p.body?.attachmentId,
        disposition: p.headers?.find((h: any) => h.name.toLowerCase() === 'content-disposition')?.value ?? null,
        contentId: p.headers?.find((h: any) => h.name.toLowerCase() === 'content-id')?.value ?? null })
      ;(p.parts ?? []).forEach((x: any) => walk(x, depth + 1))
    }
    walk(gm.payload, 0)
    let html = ''
    const find = (p: any) => { if (p.mimeType === 'text/html' && p.body?.data && !html) html = atob(p.body.data.replace(/-/g, '+').replace(/_/g, '/')); (p.parts ?? []).forEach(find) }
    find(gm.payload)
    const linkHosts = [...new Set([...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((x) => { try { const U = new URL(x[1]); return U.host + U.pathname.slice(0, 48) } catch { return x[1].slice(0, 48) } }))].slice(0, 20)
    return c.json({ parts, linkHosts, sizeEstimate: (gm as any).sizeEstimate ?? null })
  } catch (e: any) { return c.json({ error: e.message }, 502) } finally { await sql.end() }
})

// GET /api/gmail/attachments/:id — stream a customer attachment from Gmail to a logged-in member of staff.
// Bytes go Gmail → Worker → browser only. Nothing is cached, stored, or sent to OpenAI.
gmailApi.get('/attachments/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const sql = getDb(c.env)
  try {
    const [a] = await sql`SELECT * FROM attachments WHERE id = ${id}`
    if (!a) return c.json({ error: 'Attachment not found' }, 404)
    if (a.source !== 'gmail' || !a.gmail_message_id || !a.gmail_attachment_id) return c.json({ error: 'Not available yet (R2 storage not enabled)' }, 501)
    const token = await accessToken(c.env, sql)
    const bytes = await getAttachment(token, a.gmail_message_id, a.gmail_attachment_id)
    const safeType = /^(image\/(jpeg|png|gif|webp)|application\/pdf)$/.test(a.mime_type) ? a.mime_type : 'application/octet-stream'
    const disposition = safeType === 'application/octet-stream' ? 'attachment' : 'inline'
    return new Response(bytes, {
      headers: {
        'Content-Type': safeType,
        'Content-Disposition': `${disposition}; filename="${String(a.filename).replace(/[^\w.\- ]/g, '_')}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
      },
    })
  } catch (e: any) {
    return c.json({ error: e.message }, 502)
  } finally {
    await sql.end()
  }
})

// GET /api/gmail/attachment-rules — the limits the UI enforces (same constants the server uses)
gmailApi.get('/attachment-rules', (c) => c.json(AMAZON_ATTACHMENT_RULES))

// POST /api/gmail/attachment-check {files:[{filename,mime_type,size_bytes}], body?} — pre-flight validation for uploads
gmailApi.post('/attachment-check', async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { files?: any[]; body?: string }
  const files = (b.files ?? []).map((f) => ({ filename: String(f.filename ?? ''), mime_type: String(f.mime_type ?? ''), size_bytes: Number(f.size_bytes) || 0 }))
  return c.json(checkAttachments(files, b.body ?? ''))
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
    // Seller Central / chargeback statements are never emailed to the customer.
    // Chargeback evidence MAY be emailed to Amazon's chargeback mailbox, but only when:
    //   (a) CHARGEBACK_EMAIL_ENABLED=true is set as a Worker secret (manual switch after verifying a real notice), and
    //   (b) the notice's Reply-To was classified as a real Amazon mailbox (not a no-reply address).
    if (d.mode && d.mode !== 'customer') {
      if (d.mode !== 'chargeback_evidence')
        return c.json({ error: 'This draft is for Seller Central, not an email. Use Copy and paste it into Seller Central, then Mark as sent.' }, 400)
      if (String((c.env as any).CHARGEBACK_EMAIL_ENABLED ?? '').toLowerCase() !== 'true')
        return c.json({ error: 'Emailing chargeback evidence is switched off until the Amazon Reply-To address has been verified on a real notice. Copy the text into Seller Central instead.' }, 400)
      const [ev] = await sql`SELECT reply_to, reply_to_status FROM amazon_events WHERE case_id = ${d.case_id} AND kind = 'chargeback' ORDER BY received_at DESC LIMIT 1`
      if (!ev || ev.reply_to_status !== 'mailbox')
        return c.json({ error: `Amazon's Reply-To on this chargeback notice is ${ev?.reply_to_status === 'noreply' ? 'a no-reply address' : 'unverified'} (${ev?.reply_to || 'unknown'}). It cannot be emailed — paste the evidence into Seller Central.` }, 400)
      return c.json({ error: 'Chargeback email delivery is not wired yet (Step C part 2). Paste into Seller Central.' }, 501)
    }
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
