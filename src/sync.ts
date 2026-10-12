// Gmail → cases sync. Read-only against Gmail. Runs from the cron trigger and from a manual button.
import type { Bindings, Sql } from './db'
import { redactPii } from './ai'
import { accessToken, listThreadIds, getThread, header, messageBody, type GmailMessage } from './gmail'
import { classifyNotice, parseSellerReplyCopy, parseAtoz, parseReturnAuth, parseChargeback, redactChargebackPii } from './amazon'
import { classifyTone } from './tone'
import { listAttachments } from './gmail'
import { isAllowedType } from './attachments'

const AMAZON_DOMAIN = 'marketplace.amazon.co.uk'
const DEFAULT_LOOKBACK = 'newer_than:1h' // generous relative to the 15-min cron so a missed run cannot drop mail

export type SyncResult = { threadsSeen: number; messagesNew: number; casesNew: number; skipped: { thread: string; reason: string }[]; query: string; remaining: number }

const ORDER_RE = /\b(\d{3}-\d{7}-\d{7})\b/

/** "Jane Smith <xyz@marketplace.amazon.co.uk>" → { name: "Jane Smith", address: "xyz@…" } */
function parseAddress(v: string) {
  const m = v.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/)
  if (m) return { name: m[1].trim(), address: m[2].trim().toLowerCase() }
  return { name: '', address: v.trim().toLowerCase() }
}

function splitName(full: string) {
  const clean = full.replace(/\s+/g, ' ').replace(/["']/g, '').trim()
  if (!clean) return { first: 'Customer', last: null as string | null }
  const parts = clean.split(' ')
  const first = parts[0].replace(/[^\p{L}\p{M}'-]/gu, '') || 'Customer'
  const last = parts.length > 1 ? parts.slice(1).join(' ') : null
  return { first: first.charAt(0).toUpperCase() + first.slice(1), last }
}

export type ParsedAmazon = { text: string; orderId: string | null; product: string | null; asin: string | null }

/**
 * Extract the customer's own words (and order/product metadata) from an Amazon
 * buyer-seller notification. Handles the current template:
 *   "Order ID: 206-…:"  …  "Message:" <text> "View Message" / "Resolve Case" …
 * and the older "------ Begin message ------ … ------ End message ------" wrapper.
 */
export function parseAmazonBody(raw: string): ParsedAmazon {
  let t = raw.replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ')
  const orderId = t.match(ORDER_RE)?.[1] ?? null
  const asin = t.match(/\b(B0[A-Z0-9]{8})\b/)?.[1] ?? null
  // Product line, two known shapes:
  //   "1 / Apple iPhone 15 Pro Max (256 GB) - Black Titanium (Renewed) [ASIN: B0CVJVM1DH]"   (text/plain)
  //   "1<tab>B0CVJVM1DH<tab>Apple iPhone 15 Pro Max …"                                        (html→text)
  const prodLine =
    t.match(/^\s*\d+\s*\/\s*(.+?)\s*\[ASIN:/m)?.[1]?.trim() ??
    t.match(/^\s*\d+[\t ]+B0[A-Z0-9]{8}[\t ]+(.+)$/m)?.[1]?.trim() ??
    null

  let text: string | null = null
  // Shape A (text/plain): "------ Message: ------" … "------ End message ------"
  const mA = t.match(/-{3,}\s*(?:Begin message|Message:?)\s*-{3,}\s*\n([\s\S]*?)\n\s*-{3,}\s*End message\s*-{3,}/i)
  if (mA) text = mA[1]
  // Shape B (html→text): "Message:" line … up to "View Message"/"Resolve Case"/footer
  if (text === null) {
    const msgIdx = t.search(/^\s*Message:\s*$/m)
    if (msgIdx !== -1) {
      let after = t.slice(t.indexOf('\n', msgIdx) + 1)
      const stop = after.search(/^\s*(View Message|Resolve Case|Report suspicious activity|This service is provided|Was this e-?mail helpful|Copyright \d{4} Amazon|\[commMgrTok)/im)
      if (stop !== -1) after = after.slice(0, stop)
      text = after
    }
  }
  if (text === null) text = t

  for (const re of [/^On .{10,120} wrote:\s*$/m, /^-{2,}\s*Original Message\s*-{2,}$/im, /^_{10,}$/m, /^Sent from my /m, /^\s*Was this e-?mail helpful/im, /^\s*Copyright \d{4} Amazon/im, /^\s*For your information:/im, /^\s*\[commMgrTok/m]) {
    const m = text.match(re)
    if (m && m.index !== undefined && m.index > 20) text = text.slice(0, m.index)
  }
  text = text.split('\n').filter((l) => !/^>/.test(l)).join('\n')
  text = text.replace(/\n{3,}/g, '\n\n').trim()
  return { text, orderId, product: prodLine, asin }
}

/** Amazon CS relays ("Dear Amazon Seller, This is Amazon's Customer Service team…") are still customer-facing context; label them. */
export const isAmazonCsRelay = (text: string) => /this is amazon.{0,3}s customer service team/i.test(text)

/** Back-compat helper used in tests. */
export const cleanAmazonBody = (raw: string) => parseAmazonBody(raw).text

/** "Amazon Payments customer inquiry: Received Damaged Defective or Wrong item Chris (Order: 206-…)" → "Received Damaged Defective or Wrong item" */
function cleanSubject(subj: string) {
  let x = subj.replace(/^(re|fwd?):\s*/i, '')
  x = x.replace(/^Amazon(?: Payments)? customer inquiry:\s*/i, '').replace(/^Message from Amazon customer\s*/i, '')
  x = x.replace(/\s*\(Order:?\s*\d{3}-\d{7}-\d{7}\)\s*$/i, '')
  // trailing customer name token (Amazon appends the buyer's name before the order)
  x = x.replace(/\s+[A-Z][\p{L}'-]+$/u, (m) => (x.split(' ').length > 3 ? '' : m))
  return x.trim().slice(0, 300) || 'Customer message'
}

/** For our own sent replies: keep only the top part above any quoted history. */
function stripQuoted(raw: string) {
  let t = raw.replace(/\r\n/g, '\n')
  for (const re of [/^On .{10,120} wrote:\s*$/m, /^-{2,}\s*Original Message\s*-{2,}$/im, /^From: .*$/m, /^_{10,}$/m]) {
    const m = t.match(re)
    if (m && m.index !== undefined && m.index > 20) t = t.slice(0, m.index)
  }
  return t.split('\n').filter((l) => !/^>/.test(l)).join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function isOurs(m: GmailMessage, ourEmail: string) {
  const from = parseAddress(header(m, 'From')).address
  return from === ourEmail.toLowerCase() || (m.labelIds ?? []).includes('SENT')
}

async function nextCaseRef(sql: Sql) {
  // Dedicated sequence; seeded above the highest existing RIQ-#### on first use.
  await sql`CREATE SEQUENCE IF NOT EXISTS case_ref_seq`
  const [{ n }] = await sql`SELECT nextval('case_ref_seq')::int AS n`
  if (n === 1) {
    const [{ mx }] = await sql`SELECT COALESCE(MAX(substring(case_ref from '[0-9]+$')::int), 1000) AS mx FROM cases`
    await sql`SELECT setval('case_ref_seq', ${Number(mx) + 1})`
    return `RIQ-${Number(mx) + 1}`
  }
  return `RIQ-${n}`
}

export async function runSync(env: Bindings, sql: Sql, trigger: 'cron' | 'manual' | 'import', opts: { lookbackDays?: number } = {}): Promise<SyncResult> {
  const [run] = await sql`INSERT INTO sync_runs (trigger) VALUES (${trigger}) RETURNING id`
  const result: SyncResult = { threadsSeen: 0, messagesNew: 0, casesNew: 0, skipped: [], query: '', remaining: 0 }
  try {
    const { token, conn } = await accessToken(env, sql)
    const ourEmail = conn.email_address
    const lookback = opts.lookbackDays ? `newer_than:${opts.lookbackDays}d` : DEFAULT_LOOKBACK
    // Customer messages + Seller Central reply copies + A-to-Z + returns + chargebacks
    const q = `(from:${AMAZON_DOMAIN} OR to:${AMAZON_DOMAIN} OR from:atoz-guarantee-no-reply@amazon.co.uk OR from:cb-seller-notification@amazon.co.uk OR (from:donotreply@amazon.com (subject:"Return authorisation notification" OR subject:"Your email to"))) ${lookback}`
    result.query = q
    const allIds = await listThreadIds(token, q, opts.lookbackDays ? 500 : 60)
    // Skip threads we already have fully (cheap DB check) so repeated imports make progress
    const idList = allIds.join(',')
    await sql`CREATE TABLE IF NOT EXISTS gmail_threads_seen (thread_id TEXT PRIMARY KEY, history_id TEXT, seen_at TIMESTAMPTZ NOT NULL DEFAULT now())`
    const seen = new Set((await sql`SELECT thread_id FROM gmail_threads_seen WHERE thread_id = ANY(string_to_array(${idList}, ','))`).map((r) => r.thread_id))
    // For the normal 1h poll, re-check recent threads (a new message may have arrived on a seen thread).
    // For bulk imports, skip anything already processed so repeated rounds make progress.
    const todo = opts.lookbackDays ? allIds.filter((id) => !seen.has(id)) : allIds
    // Cloudflare caps subrequests per invocation (~50 on free, 1000 paid); each thread costs 1 Gmail call + a few DB round-trips via Hyperdrive.
    const BATCH = 12
    const threadIds = todo.slice(0, BATCH)
    result.threadsSeen = allIds.length
    result.remaining = Math.max(0, todo.length - threadIds.length)

    const pendingTone: { messageId: number; caseId: number; text: string }[] = []
    for (const tid of threadIds) {
      const thread = await getThread(token, tid)
      const msgs = thread.messages.sort((a, b) => Number(a.internalDate) - Number(b.internalDate))
      // ── Amazon notices (not customer messages): handle and move on
      const first0 = msgs[0]
      const kind0 = classifyNotice(header(first0, 'From'), header(first0, 'Subject'))
      if (kind0) {
        for (const m of msgs) {
          const r = await ingestNotice(sql, m, classifyNotice(header(m, 'From'), header(m, 'Subject')) ?? kind0, result)
          if (r === 'new') result.messagesNew++
        }
        await markSeenFor(sql, tid)
        continue
      }

      const inbound = msgs.filter((m) => !isOurs(m, ourEmail) && parseAddress(header(m, 'From')).address.endsWith(`@${AMAZON_DOMAIN}`))
      // Amazon also sends non-customer notices from this domain (e.g. order confirmations). Skip threads with no customer text.
      if (inbound.length && !parseAmazonBody(messageBody(inbound[inbound.length - 1])).text) { result.skipped.push({ thread: tid, reason: `no customer text parsed; subject="${header(inbound[0], 'Subject').slice(0, 80)}"` }); await markSeen(); continue }
      const markSeen = () => sql`INSERT INTO gmail_threads_seen (thread_id) VALUES (${tid}) ON CONFLICT (thread_id) DO UPDATE SET seen_at = now()`
      if (!inbound.length) { result.skipped.push({ thread: tid, reason: `no inbound from @${AMAZON_DOMAIN}; from=${parseAddress(header(msgs[0], 'From')).address}` }); await markSeen(); continue }

      const first = inbound[0]
      const fromParsed = parseAddress(header(first, 'From'))
      const { first: firstName, last: lastName } = splitName(fromParsed.name)
      const subject = header(first, 'Subject') || '(no subject)'
      const firstParsed = parseAmazonBody(messageBody(first))
      const orderId = subject.match(ORDER_RE)?.[1] ?? firstParsed.orderId
      const product = firstParsed.product
      const latestInboundAt = new Date(Number(inbound[inbound.length - 1].internalDate))

      // One case per ORDER (Amazon opens a new Gmail thread per message). Fall back to thread id when no order id.
      let [kase] = orderId
        ? await sql`SELECT id, last_customer_message_at, status, gmail_thread_id FROM cases WHERE source = 'gmail' AND order_id = ${orderId} ORDER BY id LIMIT 1`
        : await sql`SELECT id, last_customer_message_at, status, gmail_thread_id FROM cases WHERE gmail_thread_id = ${tid}`
      if (!kase) [kase] = await sql`SELECT id, last_customer_message_at, status, gmail_thread_id FROM cases WHERE gmail_thread_id = ${tid}`
      if (!kase) {
        const ref = await nextCaseRef(sql)
        ;[kase] = await sql`
          INSERT INTO cases (case_ref, subject, status, customer_first_name, customer_last_name, customer_email, order_id, device_model,
                             gmail_thread_id, customer_reply_to, source, last_customer_message_at)
          VALUES (${ref}, ${cleanSubject(subject)}, 'open', ${firstName}, ${lastName}, ${fromParsed.address}, ${orderId}, ${product},
                  ${tid}, ${fromParsed.address}, 'gmail', ${latestInboundAt})
          RETURNING id, last_customer_message_at, status, gmail_thread_id`
        result.casesNew++
      } else if (kase.gmail_thread_id !== tid) {
        // Newer thread for the same order → replies must go to the latest thread
        await sql`UPDATE cases SET gmail_thread_id = ${tid} WHERE id = ${kase.id} AND (SELECT max(sent_at) FROM messages WHERE case_id = ${kase.id}) < ${latestInboundAt}`
      }

      // Insert any messages we have not seen
      for (const m of msgs) {
        const [exists] = await sql`SELECT 1 FROM messages WHERE gmail_message_id = ${m.id}`
        if (exists) continue
        const ours = isOurs(m, ourEmail)
        const body = ours ? stripQuoted(messageBody(m)) : parseAmazonBody(messageBody(m)).text
        if (!body) continue
        const sender = ours ? 'Saigates Support' : isAmazonCsRelay(body) ? 'Amazon Customer Service (on behalf of customer)' : 'Customer'
        const [ins] = await sql`
          INSERT INTO messages (case_id, direction, sender, body, subject, gmail_message_id, rfc_message_id, sent_at)
          VALUES (${kase.id}, ${ours ? 'outbound' : 'inbound'}, ${sender}, ${body.slice(0, 20000)},
                  ${header(m, 'Subject') || null}, ${m.id}, ${header(m, 'Message-ID') || null}, ${new Date(Number(m.internalDate))})
          RETURNING id`
        result.messagesNew++
        await recordAttachments(sql, m, ins.id, kase.id)
        await sql`UPDATE messages SET attachments_checked_at = now() WHERE id = ${ins.id}`.catch(() => {})
        if (!ours) pendingTone.push({ messageId: ins.id, caseId: kase.id, text: body })
        if (!ours && /\b(hot|heat|heating|overheat|burn|smok|swell|swollen|bulg)/i.test(body)) await sql`UPDATE cases SET battery_flag = TRUE WHERE id = ${kase.id}`
      }

      // New customer message → reset the 24h clock and reopen if we were waiting on them
      if (latestInboundAt > new Date(kase.last_customer_message_at)) {
        await sql`UPDATE cases SET last_customer_message_at = ${latestInboundAt},
                    status = CASE WHEN status = 'awaiting_customer' THEN 'open' ELSE status END,
                    updated_at = now() WHERE id = ${kase.id}`
      }
      if (product) await sql`UPDATE cases SET device_model = ${product} WHERE id = ${kase.id} AND device_model IS NULL`
      // Latest reply-to address may rotate; keep current
      const latestFrom = parseAddress(header(inbound[inbound.length - 1], 'From')).address
      await sql`UPDATE cases SET customer_reply_to = ${latestFrom} WHERE id = ${kase.id} AND customer_reply_to IS DISTINCT FROM ${latestFrom}`
      await markSeen()
    }

    // Tone labels for new customer messages (small model, redacted text, non-fatal)
    for (const p of pendingTone.slice(0, 20)) {
      try {
        const [k] = await sql`SELECT * FROM cases WHERE id = ${p.caseId}`
        const tone = await classifyTone(env, redactPii(p.text, k as any))
        if (tone) {
          await sql`UPDATE messages SET tone = ${tone.label}, tone_source = 'ai', tone_model = ${tone.model} WHERE id = ${p.messageId} AND tone_source IS DISTINCT FROM 'staff'`
          await sql`UPDATE cases SET tone = ${tone.label} WHERE id = ${p.caseId} AND (SELECT id FROM messages WHERE case_id = ${p.caseId} AND direction = 'inbound' ORDER BY sent_at DESC LIMIT 1) = ${p.messageId}`
        }
      } catch (e) { console.error('tone failed', e) }
    }
    const note = result.skipped.length ? `skipped ${result.skipped.length}: ` + result.skipped.slice(0, 5).map((x) => x.reason).join(' | ') : null
    await sql`UPDATE sync_runs SET finished_at = now(), status = 'ok', threads_seen = ${result.threadsSeen}, messages_new = ${result.messagesNew}, cases_new = ${result.casesNew}, error = ${note} WHERE id = ${run.id}`
    await sql`UPDATE gmail_connection SET last_sync_at = now(), last_sync_status = 'ok', last_sync_error = NULL, last_sync_new_msgs = ${result.messagesNew} WHERE id = 1`
    return result
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 500)
    await sql`UPDATE sync_runs SET finished_at = now(), status = 'error', error = ${msg} WHERE id = ${run.id}`
    await sql`UPDATE gmail_connection SET last_sync_at = now(), last_sync_status = 'error', last_sync_error = ${msg} WHERE id = 1`
    throw e
  }
}

/** One-off backfill after migration 0009: attachment metadata for already-imported messages + Reply-To status on
 *  existing chargeback events. Idempotent; processes up to `limit` messages per call (Gmail subrequest budget). */
export async function backfillAttachments(env: Bindings, sql: Sql, limit = 25) {
  const { accessToken, getMessage } = await import('./gmail')
  // Reply-To status on chargeback events imported before 0009 (same classifier as live sync)
  const pending = await sql<{ id: number; reply_to: string }[]>`SELECT id, reply_to FROM amazon_events WHERE kind = 'chargeback' AND reply_to_status IS NULL AND reply_to IS NOT NULL`
  for (const e of pending) await sql`UPDATE amazon_events SET reply_to_status = ${classifyReplyTo(e.reply_to)}, reply_to_checked_at = now() WHERE id = ${e.id}`
  const rows = await sql<{ id: number; case_id: number; gmail_message_id: string }[]>`
    SELECT m.id, m.case_id, m.gmail_message_id FROM messages m
    WHERE m.gmail_message_id IS NOT NULL AND m.kind = 'message' AND m.direction = 'inbound' AND m.attachments_checked_at IS NULL
    ORDER BY m.sent_at DESC LIMIT ${limit}`
  if (!rows.length) return { checked: 0, attachments: 0, remaining: 0 }
  const token = await accessToken(env, sql)
  let found = 0
  for (const r of rows) {
    try {
      const gm = await getMessage(token, r.gmail_message_id)
      const before = (await sql`SELECT COUNT(*)::int AS n FROM attachments WHERE message_id = ${r.id}`)[0].n
      await recordAttachments(sql, gm, r.id, r.case_id)
      const after = (await sql`SELECT COUNT(*)::int AS n FROM attachments WHERE message_id = ${r.id}`)[0].n
      found += after - before
    } catch (e) { console.error('backfill message', r.gmail_message_id, (e as Error).message) }
    await sql`UPDATE messages SET attachments_checked_at = now() WHERE id = ${r.id}`
  }
  const [{ remaining }] = await sql`SELECT COUNT(*)::int AS remaining FROM messages WHERE gmail_message_id IS NOT NULL AND kind = 'message' AND direction = 'inbound' AND attachments_checked_at IS NULL`
  return { checked: rows.length, attachments: found, remaining }
}

/** Store attachment metadata only — bytes stay in Gmail and are proxied on demand. Never sent to OpenAI. */
async function recordAttachments(sql: Sql, m: GmailMessage, messageId: number, caseId: number) {
  for (const a of listAttachments(m)) {
    // Tolerates a DB without migration 0009 (table missing) — the message itself is still saved.
    await sql`INSERT INTO attachments (message_id, case_id, filename, mime_type, size_bytes, inline, source, gmail_message_id, gmail_attachment_id, amazon_allowed)
              VALUES (${messageId}, ${caseId}, ${a.filename.slice(0, 255)}, ${a.mimeType}, ${a.size}, ${a.inline}, 'gmail', ${m.id}, ${a.attachmentId}, ${isAllowedType(a.filename, a.mimeType)})
              ON CONFLICT (gmail_message_id, gmail_attachment_id) DO NOTHING`.catch((e: Error) => console.error('attachment record skipped:', e.message))
  }
}

/** Is Amazon's Reply-To on a chargeback notice a real mailbox we may answer, or a no-reply address? */
export function classifyReplyTo(replyTo: string): 'noreply' | 'mailbox' | 'unverified' {
  const addr = (replyTo.match(/<([^>]+)>/)?.[1] ?? replyTo).trim().toLowerCase()
  if (!addr || !addr.includes('@')) return 'unverified'
  if (/no-?reply|donotreply|do-not-reply|notification|noreply/.test(addr)) return 'noreply'
  if (/@(?:[\w-]+\.)*amazon\.(?:co\.uk|com|de|fr|it|es)$/.test(addr)) return 'mailbox'
  return 'unverified'
}

async function markSeenFor(sql: Sql, tid: string) {
  await sql`INSERT INTO gmail_threads_seen (thread_id) VALUES (${tid}) ON CONFLICT (thread_id) DO UPDATE SET seen_at = now()`
}

/** Find or create the case for an order referenced by an Amazon notice. */
async function caseForOrder(sql: Sql, orderId: string, opts: { firstName?: string | null; lastName?: string | null; address?: string | null; product?: string | null; subject: string; at: Date }) {
  let [k] = await sql`SELECT id, status FROM cases WHERE order_id = ${orderId} ORDER BY id LIMIT 1`
  if (k) {
    if (opts.lastName || opts.address) await sql`UPDATE cases SET customer_last_name = COALESCE(customer_last_name, ${opts.lastName ?? null}), customer_address = COALESCE(customer_address, ${opts.address ?? null}) WHERE id = ${k.id}`
    if (opts.product) await sql`UPDATE cases SET device_model = COALESCE(device_model, ${opts.product}) WHERE id = ${k.id}`
    return k
  }
  const ref = await nextCaseRef(sql)
  ;[k] = await sql`
    INSERT INTO cases (case_ref, subject, status, customer_first_name, customer_last_name, customer_address, order_id, device_model, source, last_customer_message_at)
    VALUES (${ref}, ${opts.subject.slice(0, 300)}, 'open', ${opts.firstName || 'Customer'}, ${opts.lastName ?? null}, ${opts.address ?? null}, ${orderId}, ${opts.product ?? null}, 'amazon_notice', ${opts.at})
    RETURNING id, status`
  return k
}

/** Ingest one Amazon notice email. Returns 'new' | 'dup' | 'skip'. */
export async function ingestNotice(sql: Sql, m: GmailMessage, kind: NonNullable<ReturnType<typeof classifyNotice>>, result: SyncResult): Promise<'new' | 'dup' | 'skip'> {
  const [dup] = await sql`SELECT 1 FROM messages WHERE gmail_message_id = ${m.id} UNION ALL SELECT 1 FROM amazon_events WHERE gmail_message_id = ${m.id} LIMIT 1`
  if (dup) return 'dup'
  const at = new Date(Number(m.internalDate))
  const body = messageBody(m)
  const subject = header(m, 'Subject')
  const replyTo = header(m, 'Reply-To') || header(m, 'From')

  if (kind === 'seller_reply_copy') {
    const r = parseSellerReplyCopy(body, subject)
    if (!r.orderId || !r.text) { result.skipped.push({ thread: m.threadId, reason: 'reply copy without order/text' }); return 'skip' }
    // De-dupe against a reply we sent from ReplyIQ (same case, same text, within 10 minutes)
    const k = await caseForOrder(sql, r.orderId, { subject: `Message to ${r.recipient ?? 'customer'}`, at })
    const [same] = await sql`SELECT 1 FROM messages WHERE case_id = ${k.id} AND direction = 'outbound' AND body = ${r.text} AND abs(extract(epoch from (sent_at - ${at}))) < 600`
    if (same) return 'dup'
    await sql`INSERT INTO messages (case_id, direction, sender, body, subject, gmail_message_id, rfc_message_id, sent_at, kind)
              VALUES (${k.id}, 'outbound', 'Saigates Support (via Seller Central)', ${r.text.slice(0, 20000)}, ${subject}, ${m.id}, ${header(m, 'Message-ID') || null}, ${at}, 'seller_central_copy')`
    await sql`UPDATE cases SET status = CASE WHEN status = 'open' THEN 'awaiting_customer' ELSE status END, updated_at = now() WHERE id = ${k.id} AND last_customer_message_at < ${at}`
    return 'new'
  }

  if (kind.startsWith('atoz')) {
    const r = parseAtoz(body)
    if (!r.orderId) { result.skipped.push({ thread: m.threadId, reason: 'A-to-Z without order id' }); return 'skip' }
    const k = await caseForOrder(sql, r.orderId, { subject: `A-to-Z claim${r.amount ? ` £${r.amount.toFixed(2)}` : ''}`, at })
    const evKind = kind === 'atoz_claim' && r.infoRequested ? 'atoz_info_request' : kind
    const deadline = evKind === 'atoz_info_request' ? new Date(at.getTime() + 3 * 86400_000) : null
    const status = evKind === 'atoz_decision' ? (r.decision === 'granted' ? 'lost' : r.decision === 'denied' ? 'won' : 'open') : 'open'
    const [ev] = await sql`INSERT INTO amazon_events (case_id, order_id, kind, status, amount, received_at, deadline_at, gmail_message_id, gmail_thread_id, raw_excerpt, reply_to)
              VALUES (${k.id}, ${r.orderId}, ${evKind}, ${status}, ${r.amount}, ${at}, ${deadline}, ${m.id}, ${m.threadId}, ${r.excerpt}, ${replyTo}) RETURNING id`
    await sql`INSERT INTO messages (case_id, direction, sender, body, subject, gmail_message_id, sent_at, kind, event_id)
              VALUES (${k.id}, 'inbound', 'Amazon A-to-z Guarantee', ${r.excerpt}, ${subject}, ${m.id}, ${at}, 'event', ${ev.id})`
    if (evKind !== 'atoz_decision') await sql`UPDATE cases SET a_to_z_open = TRUE, updated_at = now() WHERE id = ${k.id}`
    if (evKind === 'atoz_decision') await sql`UPDATE cases SET a_to_z_open = FALSE, updated_at = now() WHERE id = ${k.id}`
    return 'new'
  }

  if (kind === 'return_request') {
    const r = parseReturnAuth(body)
    if (!r.orderId) { result.skipped.push({ thread: m.threadId, reason: 'return auth without order id' }); return 'skip' }
    const k = await caseForOrder(sql, r.orderId, { subject: `Return: ${r.reason ?? 'requested'}`, product: r.product, at })
    const [ev] = await sql`INSERT INTO amazon_events (case_id, order_id, kind, status, received_at, return_request_date, policy_check, authorisation, asin, sku, quantity, return_reason, customer_comment, product, gmail_message_id, gmail_thread_id, raw_excerpt)
              VALUES (${k.id}, ${r.orderId}, 'return_request', 'requested', ${at}, ${r.requestDate}, ${r.policyCheck}, ${r.authorisation}, ${r.asin}, ${r.sku}, ${r.quantity}, ${r.reason}, ${r.comment}, ${r.product}, ${m.id}, ${m.threadId}, ${r.excerpt}) RETURNING id`
    await sql`INSERT INTO messages (case_id, direction, sender, body, subject, gmail_message_id, sent_at, kind, event_id)
              VALUES (${k.id}, 'inbound', 'Amazon Returns', ${r.excerpt + (r.comment ? `\nCustomer comment: ${r.comment}` : '')}, ${subject}, ${m.id}, ${at}, 'event', ${ev.id})`
    if (r.heat) await sql`UPDATE cases SET battery_flag = TRUE, updated_at = now() WHERE id = ${k.id}`
    return 'new'
  }

  if (kind === 'chargeback') {
    const r = parseChargeback(body)
    if (!r.orderId) { result.skipped.push({ thread: m.threadId, reason: 'chargeback without order id' }); return 'skip' }
    const nameParts = (r.customerName ?? '').trim().split(/\s+/)
    const k = await caseForOrder(sql, r.orderId, { subject: `Chargeback${r.amount ? ` ${r.currency} ${r.amount.toFixed(2)}` : ''}`, firstName: nameParts[0] || null, lastName: nameParts.slice(1).join(' ') || null, address: r.customerAddress, product: r.itemDescription, at })
    const deadline = new Date(at.getTime() + 7 * 86400_000)
    const excerptRedacted = redactChargebackPii(`Chargeback dispute on ${r.itemDescription ?? 'order'} for ${r.currency} ${r.amount?.toFixed(2) ?? '?'}. Amazon requires: ${r.checklist.join('; ')}`, r)
    const [ev] = await sql`INSERT INTO amazon_events (case_id, order_id, kind, status, amount, currency, received_at, deadline_at, order_date, item_description, reply_to, reply_to_status, reply_to_checked_at, product, gmail_message_id, gmail_thread_id, raw_excerpt)
              VALUES (${k.id}, ${r.orderId}, 'chargeback', 'open', ${r.amount}, ${r.currency}, ${at}, ${deadline}, ${r.orderDate}, ${r.itemDescription}, ${replyTo}, ${classifyReplyTo(replyTo)}, now(), ${r.itemDescription}, ${m.id}, ${m.threadId}, ${excerptRedacted}) RETURNING id`
      .catch(() => sql`INSERT INTO amazon_events (case_id, order_id, kind, status, amount, currency, received_at, deadline_at, order_date, item_description, reply_to, product, gmail_message_id, gmail_thread_id, raw_excerpt)
              VALUES (${k.id}, ${r.orderId}, 'chargeback', 'open', ${r.amount}, ${r.currency}, ${at}, ${deadline}, ${r.orderDate}, ${r.itemDescription}, ${replyTo}, ${r.itemDescription}, ${m.id}, ${m.threadId}, ${excerptRedacted}) RETURNING id`)
    await sql`INSERT INTO messages (case_id, direction, sender, body, subject, gmail_message_id, sent_at, kind, event_id)
              VALUES (${k.id}, 'inbound', 'Amazon Chargebacks', ${excerptRedacted}, ${subject}, ${m.id}, ${at}, 'event', ${ev.id})`
    await sql`UPDATE cases SET chargeback_open = TRUE, updated_at = now() WHERE id = ${k.id}`
    return 'new'
  }
  return 'skip'
}
