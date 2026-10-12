// Gmail → cases sync. Read-only against Gmail. Runs from the cron trigger and from a manual button.
import type { Bindings, Sql } from './db'
import { accessToken, listThreadIds, getThread, header, messageBody, type GmailMessage } from './gmail'

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
    const q = `(from:${AMAZON_DOMAIN} OR to:${AMAZON_DOMAIN}) ${lookback}`
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

    for (const tid of threadIds) {
      const thread = await getThread(token, tid)
      const msgs = thread.messages.sort((a, b) => Number(a.internalDate) - Number(b.internalDate))
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
        await sql`
          INSERT INTO messages (case_id, direction, sender, body, subject, gmail_message_id, rfc_message_id, sent_at)
          VALUES (${kase.id}, ${ours ? 'outbound' : 'inbound'}, ${sender}, ${body.slice(0, 20000)},
                  ${header(m, 'Subject') || null}, ${m.id}, ${header(m, 'Message-ID') || null}, ${new Date(Number(m.internalDate))})`
        result.messagesNew++
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
