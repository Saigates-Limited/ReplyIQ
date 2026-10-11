// Gmail → cases sync. Read-only against Gmail. Runs from the cron trigger and from a manual button.
import type { Bindings, Sql } from './db'
import { accessToken, listThreadIds, getThread, header, messageBody, type GmailMessage } from './gmail'

const AMAZON_DOMAIN = 'marketplace.amazon.co.uk'
const LOOKBACK = 'newer_than:1h' // generous relative to the 15-min cron so a missed run cannot drop mail
const MAX_THREADS = 60

export type SyncResult = { threadsSeen: number; messagesNew: number; casesNew: number }

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

/** Strip Amazon boilerplate and quoted history from a buyer-seller message body. */
export function cleanAmazonBody(raw: string): string {
  let t = raw.replace(/\r\n/g, '\n')
  // Amazon wraps the buyer text between markers in many templates
  const begin = t.search(/-{3,}\s*Begin message\s*-{3,}/i)
  const end = t.search(/-{3,}\s*End message\s*-{3,}/i)
  if (begin !== -1 && end !== -1 && end > begin) t = t.slice(t.indexOf('\n', begin) + 1, end)
  // Drop quoted replies and signatures
  const cutMarkers = [/^On .{10,120} wrote:\s*$/m, /^-{2,}\s*Original Message\s*-{2,}$/im, /^From: .*$/m, /^_{10,}$/m, /^Sent from my /m]
  for (const re of cutMarkers) {
    const m = t.match(re)
    if (m && m.index !== undefined && m.index > 40) t = t.slice(0, m.index)
  }
  t = t.split('\n').filter((l) => !/^>/.test(l)).join('\n')
  // Amazon footer lines
  t = t.replace(/\n.*(?:Amazon\.co\.uk|amazon\.co\.uk\/gp\/help|Message from|This message was sent|Buyer-Seller Messaging|Important:|Please reply to this email).*$/gims, '')
  return t.replace(/\n{3,}/g, '\n\n').trim()
}

function isOurs(m: GmailMessage, ourEmail: string) {
  const from = parseAddress(header(m, 'From')).address
  return from === ourEmail.toLowerCase() || (m.labelIds ?? []).includes('SENT')
}

let nextRefCache: number | null = null
async function nextCaseRef(sql: Sql) {
  if (nextRefCache === null) {
    const [{ max }] = await sql`SELECT COALESCE(MAX(NULLIF(regexp_replace(case_ref, '\D', '', 'g'), '')::int), 1000) AS max FROM cases`
    nextRefCache = Number(max)
  }
  nextRefCache += 1
  return `RIQ-${nextRefCache}`
}

export async function runSync(env: Bindings, sql: Sql, trigger: 'cron' | 'manual'): Promise<SyncResult> {
  const [run] = await sql`INSERT INTO sync_runs (trigger) VALUES (${trigger}) RETURNING id`
  const result: SyncResult = { threadsSeen: 0, messagesNew: 0, casesNew: 0 }
  nextRefCache = null
  try {
    const { token, conn } = await accessToken(env, sql)
    const ourEmail = conn.email_address
    const q = `from:${AMAZON_DOMAIN} OR to:${AMAZON_DOMAIN} ${LOOKBACK}`
    const threadIds = await listThreadIds(token, q, MAX_THREADS)
    result.threadsSeen = threadIds.length

    for (const tid of threadIds) {
      const thread = await getThread(token, tid)
      const msgs = thread.messages.sort((a, b) => Number(a.internalDate) - Number(b.internalDate))
      const inbound = msgs.filter((m) => !isOurs(m, ourEmail) && parseAddress(header(m, 'From')).address.endsWith(`@${AMAZON_DOMAIN}`))
      if (!inbound.length) continue // not a customer thread

      const first = inbound[0]
      const fromParsed = parseAddress(header(first, 'From'))
      const { first: firstName, last: lastName } = splitName(fromParsed.name)
      const subject = header(first, 'Subject') || '(no subject)'
      const orderId = subject.match(ORDER_RE)?.[1] ?? messageBody(first).match(ORDER_RE)?.[1] ?? null
      const latestInboundAt = new Date(Number(inbound[inbound.length - 1].internalDate))

      // Upsert case by thread id
      let [kase] = await sql`SELECT id, last_customer_message_at, status FROM cases WHERE gmail_thread_id = ${tid}`
      if (!kase) {
        const ref = await nextCaseRef(sql)
        ;[kase] = await sql`
          INSERT INTO cases (case_ref, subject, status, customer_first_name, customer_last_name, customer_email, order_id,
                             gmail_thread_id, customer_reply_to, source, last_customer_message_at)
          VALUES (${ref}, ${subject.replace(/^(re|fwd?):\s*/i, '').slice(0, 300)}, 'open', ${firstName}, ${lastName}, ${fromParsed.address}, ${orderId},
                  ${tid}, ${fromParsed.address}, 'gmail', ${latestInboundAt})
          RETURNING id, last_customer_message_at, status`
        result.casesNew++
      }

      // Insert any messages we have not seen
      for (const m of msgs) {
        const [exists] = await sql`SELECT 1 FROM messages WHERE gmail_message_id = ${m.id}`
        if (exists) continue
        const ours = isOurs(m, ourEmail)
        const body = ours ? messageBody(m).trim() : cleanAmazonBody(messageBody(m))
        if (!body) continue
        await sql`
          INSERT INTO messages (case_id, direction, sender, body, subject, gmail_message_id, rfc_message_id, sent_at)
          VALUES (${kase.id}, ${ours ? 'outbound' : 'inbound'}, ${ours ? 'Saigates Support' : 'Customer'}, ${body.slice(0, 20000)},
                  ${header(m, 'Subject') || null}, ${m.id}, ${header(m, 'Message-ID') || null}, ${new Date(Number(m.internalDate))})`
        result.messagesNew++
      }

      // New customer message → reset the 24h clock and reopen if we were waiting on them
      if (latestInboundAt > new Date(kase.last_customer_message_at)) {
        await sql`UPDATE cases SET last_customer_message_at = ${latestInboundAt},
                    status = CASE WHEN status = 'awaiting_customer' THEN 'open' ELSE status END,
                    updated_at = now() WHERE id = ${kase.id}`
      }
      // Latest reply-to address may rotate; keep current
      const latestFrom = parseAddress(header(inbound[inbound.length - 1], 'From')).address
      await sql`UPDATE cases SET customer_reply_to = ${latestFrom} WHERE id = ${kase.id} AND customer_reply_to IS DISTINCT FROM ${latestFrom}`
    }

    await sql`UPDATE sync_runs SET finished_at = now(), status = 'ok', threads_seen = ${result.threadsSeen}, messages_new = ${result.messagesNew}, cases_new = ${result.casesNew} WHERE id = ${run.id}`
    await sql`UPDATE gmail_connection SET last_sync_at = now(), last_sync_status = 'ok', last_sync_error = NULL, last_sync_new_msgs = ${result.messagesNew} WHERE id = 1`
    return result
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 500)
    await sql`UPDATE sync_runs SET finished_at = now(), status = 'error', error = ${msg} WHERE id = ${run.id}`
    await sql`UPDATE gmail_connection SET last_sync_at = now(), last_sync_status = 'error', last_sync_error = ${msg} WHERE id = 1`
    throw e
  }
}
