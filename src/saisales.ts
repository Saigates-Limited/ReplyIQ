// Saisales.co.uk (Shopify store) customer mail → ReplyIQ cases. Read-only against Gmail, like the Amazon sync.
//
// Runs for every enabled mailbox with "Saisales mail" switched on (Gmail page). It reads mail sent to the Saisales addresses
// (info@ / support@saisales.co.uk) and the Shopify contact form ("New customer message", from mailer@shopify.com with the
// customer's address as Reply-To), opens one case per conversation marked channel = 'shopify', and links the Shopify order:
//   1. an order number the customer quotes ("#1094", "order 1094"), checked against Shopify, else
//   2. the customer's most recent order placed with the same email address.
// Two emails about the same order land on one case. Replies go out from the same mailbox as the Saisales address.
import type { Bindings, Sql } from './db'
import { header, messageBody, listThreadIds, getThread, accessToken, GmailQuotaError, type GmailMessage, type GmailConnection } from './gmail'
import { parseAddress, splitName, stripQuoted, alreadyImported, markSeenFor, nextCaseRef, recordAttachments, type SyncResult } from './sync'
import { shopifyConfigured, findOrderByName, findOrdersByEmail, orderRefsInText, attachOrderToCase } from './shopify'
import { classifyTone } from './tone'
import { redactPii } from './ai'

export type SaisalesSettings = { addresses: string[]; from_address: string; from_name: string }
export const DEFAULT_SAISALES: SaisalesSettings = {
  addresses: ['info@saisales.co.uk', 'support@saisales.co.uk'],
  from_address: 'info@saisales.co.uk',
  from_name: 'Saisales Customer Support',
}
const EMAIL = /^[^\s@"'<>]+@[^\s@"'<>]+\.[^\s@"'<>]+$/

export async function getSaisalesSettings(sql: Sql): Promise<SaisalesSettings> {
  try {
    const [r] = await sql`SELECT value FROM app_settings WHERE key = 'saisales'`
    const v = (typeof r?.value === 'string' ? JSON.parse(r.value) : r?.value ?? {}) as Partial<SaisalesSettings>
    const addresses = (Array.isArray(v.addresses) ? v.addresses : DEFAULT_SAISALES.addresses).map((a) => String(a).trim().toLowerCase()).filter((a) => EMAIL.test(a))
    return {
      addresses: addresses.length ? addresses : DEFAULT_SAISALES.addresses,
      from_address: EMAIL.test(String(v.from_address ?? '')) ? String(v.from_address).trim().toLowerCase() : DEFAULT_SAISALES.from_address,
      from_name: String(v.from_name ?? '').trim().slice(0, 60) || DEFAULT_SAISALES.from_name,
    }
  } catch { return { ...DEFAULT_SAISALES } }
}

export async function saveSaisalesSettings(sql: Sql, patch: Partial<SaisalesSettings>, userId: number) {
  const cur = await getSaisalesSettings(sql)
  const addresses = Array.isArray(patch.addresses) ? patch.addresses.map((a) => String(a).trim().toLowerCase()).filter((a) => EMAIL.test(a)).slice(0, 6) : cur.addresses
  const from = patch.from_address !== undefined ? String(patch.from_address).trim().toLowerCase() : cur.from_address
  if (!EMAIL.test(from)) throw new Error('The "send from" address is not a valid email address')
  if (!addresses.length) throw new Error('Add at least one Saisales address')
  const next: SaisalesSettings = { addresses, from_address: from, from_name: patch.from_name !== undefined ? String(patch.from_name).trim().slice(0, 60) || DEFAULT_SAISALES.from_name : cur.from_name }
  await sql`INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ('saisales', ${sql.json(next as any)}, ${userId}, now())
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`
  return next
}

/** Gmail search for Saisales customer mail (and our own replies on those threads). */
export function saisalesQuery(s: SaisalesSettings, lookback: string) {
  const to = s.addresses.flatMap((a) => [`to:${a}`, `cc:${a}`, `deliveredto:${a}`])
  return `{${to.join(' ')} (from:mailer@shopify.com subject:"customer message")} -from:me ${lookback}`
}

// ───────── Parsing ─────────
export type ContactForm = { name: string | null; email: string | null; phone: string | null; message: string; orderRef: string | null }

/** Shopify contact-form notification: "Name: …", "Email: …", "Phone Number: …", "Comment:/Body:/Message: …". */
export function parseContactForm(raw: string): ContactForm | null {
  const t = raw.replace(/\r\n/g, '\n').replace(/ /g, ' ')
  const field = (label: string) => t.match(new RegExp(`^\\s*${label}\\s*:\\s*(.*)$`, 'im'))?.[1]?.trim() || null
  const email = field('E-?mail')
  const msgM = t.match(/^\s*(?:Comment|Body|Message|Your message|Enquiry)\s*:\s*([\s\S]*)$/im)
  if (!msgM && !email) return null
  let message = (msgM?.[1] ?? '').trim()
  // Footer Shopify adds under the message
  const stop = message.search(/^\s*(?:You received this|This message was sent|Sent from (?:your|the) (?:online )?store|—{2,}|-{3,})/im)
  if (stop > 0) message = message.slice(0, stop).trim()
  return {
    name: field('Name') ?? field('First name'),
    email: email && EMAIL.test(email.toLowerCase()) ? email.toLowerCase() : null,
    phone: field('Phone(?: number)?'),
    message,
    orderRef: field('Order(?: number| no\\.?)?'),
  }
}

export const isContactFormEmail = (m: GmailMessage) =>
  /mailer@shopify\.com/i.test(header(m, 'From')) && /customer message|contact form/i.test(header(m, 'Subject'))

/** Bulk or automatic mail that must never become a case (newsletters, bounces, notifications, Amazon). */
export function isAutomated(m: GmailMessage): boolean {
  const from = parseAddress(header(m, 'From')).address
  if (isContactFormEmail(m)) return false
  if (/^(?:no-?reply|do-?not-?reply|noreply|mailer-daemon|postmaster|notifications?|bounce|alerts?)@/i.test(from)) return true
  if (/@(?:[\w-]+\.)*(?:shopify\.com|amazon\.[a-z.]+|marketplace\.amazon\.[a-z.]+|google\.com|facebookmail\.com|paypal\.[a-z.]+)$/i.test(from)) return true
  if (header(m, 'List-Unsubscribe') || /^(?:bulk|list|junk)$/i.test(header(m, 'Precedence')) || /auto-(?:generated|replied)/i.test(header(m, 'Auto-Submitted'))) return true
  return false
}

/** Who the customer is and what they wrote, for one inbound email. */
export function customerOf(m: GmailMessage): { address: string; name: string; text: string; form: ContactForm | null } {
  const raw = messageBody(m)
  if (isContactFormEmail(m)) {
    const form = parseContactForm(raw)
    const replyTo = parseAddress(header(m, 'Reply-To')).address
    const address = (form?.email || (EMAIL.test(replyTo) ? replyTo : '')).toLowerCase()
    return { address, name: form?.name ?? parseAddress(header(m, 'Reply-To')).name ?? '', text: (form?.message || ownWords(raw)).trim(), form }
  }
  const from = parseAddress(header(m, 'Reply-To') || header(m, 'From'))
  return { address: from.address, name: from.name, text: ownWords(raw), form: null }
}

/** The customer's own words: quoted history removed even when the reply is very short ("Is it unlocked?"). */
export function ownWords(raw: string) {
  let t = stripQuoted(raw)
  for (const re of [/\n?\s*On .{10,160}\bwrote:\s*$/s, /\n?\s*-{2,}\s*Original Message\s*-{2,}[\s\S]*$/i, /\n?\s*From: .*\n(?:Sent|Date): [\s\S]*$/i]) t = t.replace(re, '')
  return t.trim()
}

// ───────── Sync ─────────
const SUBJECT_CLEAN = (s: string) => s.replace(/^(?:\s*(?:re|fwd?|aw)\s*:\s*)+/i, '').replace(/^New customer message on .*/i, 'Website contact form').trim().slice(0, 300) || 'Customer message'

export async function syncSaisalesMailbox(env: Bindings, sql: Sql, conn: GmailConnection, ourEmails: string[], opts: { lookbackDays?: number; batch?: number }): Promise<SyncResult> {
  const s = await getSaisalesSettings(sql)
  const ours = new Set([...ourEmails, ...s.addresses, s.from_address].map((e) => e.toLowerCase()))
  const result: SyncResult = { threadsSeen: 0, messagesNew: 0, casesNew: 0, skipped: [], query: '', remaining: 0 }
  const { token } = await accessToken(env, sql, conn.id)
  const q = saisalesQuery(s, opts.lookbackDays ? `newer_than:${opts.lookbackDays}d` : 'newer_than:1h')
  result.query = q
  const ids = await listThreadIds(token, q, opts.lookbackDays ? 300 : 40)
  const seenKey = (tid: string) => `ss${conn.id}:${tid}`
  const seen = new Set((await sql`SELECT thread_id FROM gmail_threads_seen WHERE thread_id = ANY(string_to_array(${ids.map(seenKey).join(',')}, ','))`).map((r: any) => r.thread_id))
  const todo = opts.lookbackDays ? ids.filter((id) => !seen.has(seenKey(id))) : ids
  const batch = todo.slice(0, opts.batch ?? 20)
  result.threadsSeen = ids.length
  result.remaining = Math.max(0, todo.length - batch.length)
  const shopify = shopifyConfigured(env)
  const isOurs = (m: GmailMessage) => ours.has(parseAddress(header(m, 'From')).address) || (m.labelIds ?? []).includes('SENT')

  for (const tid of batch) {
    let thread
    try { thread = await getThread(token, tid) } catch (e) { if (e instanceof GmailQuotaError) { result.remaining += batch.length - batch.indexOf(tid); break } throw e }
    const msgs = thread.messages.sort((a, b) => Number(a.internalDate) - Number(b.internalDate))
    const inbound = msgs.filter((m) => !isOurs(m) && !isAutomated(m))
    if (!inbound.length) { result.skipped.push({ thread: tid, reason: `saisales: no customer message (from=${parseAddress(header(msgs[0], 'From')).address})` }); await markSeenFor(sql, seenKey(tid)); continue }
    const first = customerOf(inbound[0])
    const latest = customerOf(inbound[inbound.length - 1])
    if (!first.address || !EMAIL.test(first.address)) { result.skipped.push({ thread: tid, reason: 'saisales: no customer email address' }); await markSeenFor(sql, seenKey(tid)); continue }
    const subject = header(inbound[0], 'Subject') || '(no subject)'
    const latestAt = new Date(Number(inbound[inbound.length - 1].internalDate))
    const { first: firstName, last: lastName } = splitName(first.name || '')

    // Shopify order: quoted order number first, then the customer's latest order.
    let order: any = null
    if (shopify) {
      try {
        const refs = [...new Set([first.form?.orderRef, ...orderRefsInText(subject), ...inbound.flatMap((m) => orderRefsInText(customerOf(m).text))].filter(Boolean) as string[])]
        for (const r of refs) { order = await findOrderByName(env, sql, r); if (order) break }
        if (!order) order = (await findOrdersByEmail(env, sql, first.address, 1))[0] ?? null
      } catch (e: any) { result.skipped.push({ thread: tid, reason: `saisales: Shopify lookup failed (${String(e?.message ?? e).slice(0, 120)}); case kept without order` }) }
    }

    // Existing case: same thread, else an open Saisales case on the same order, else the same email already imported.
    let [kase] = await sql`SELECT id, status, last_customer_message_at, gmail_thread_id FROM cases WHERE gmail_thread_id = ${tid} AND channel = 'shopify' LIMIT 1`
    if (!kase && order) [kase] = await sql`SELECT id, status, last_customer_message_at, gmail_thread_id FROM cases WHERE shopify_order_gid = ${order.id} AND channel = 'shopify' AND archived_at IS NULL ORDER BY id DESC LIMIT 1`
    if (!kase) {
      const rfc = header(inbound[0], 'Message-ID')
      if (rfc) [kase] = await sql`SELECT c.id, c.status, c.last_customer_message_at, c.gmail_thread_id FROM messages m JOIN cases c ON c.id = m.case_id WHERE m.rfc_message_id = ${rfc} AND c.channel = 'shopify' LIMIT 1`
    }
    if (!kase) {
      const ref = await nextCaseRef(sql)
      ;[kase] = await sql`
        INSERT INTO cases (case_ref, subject, status, channel, customer_first_name, customer_last_name, customer_email, customer_phone, order_id,
                           gmail_thread_id, customer_reply_to, source, last_customer_message_at, mailbox_id)
        VALUES (${ref}, ${SUBJECT_CLEAN(subject)}, 'open', 'shopify', ${firstName}, ${lastName}, ${first.address}, ${first.form?.phone ?? null}, ${order?.name ?? null},
                ${tid}, ${first.address}, 'gmail', ${latestAt}, ${conn.id})
        RETURNING id, status, last_customer_message_at, gmail_thread_id`
      result.casesNew++
    } else if (kase.gmail_thread_id !== tid) {
      // Newer conversation about the same order → replies go on the latest thread, from the mailbox it arrived in.
      await sql`UPDATE cases SET gmail_thread_id = ${tid}, mailbox_id = ${conn.id}, customer_reply_to = ${latest.address || first.address}
                WHERE id = ${kase.id} AND COALESCE((SELECT max(sent_at) FROM messages WHERE case_id = ${kase.id}), 'epoch') < ${latestAt}`
    }
    // The customer wrote again on a case whose details were cleared by the daily clean-up: take the name and reply address
    // from this email so staff can reply (same as the Amazon sync).
    await sql`UPDATE cases SET customer_first_name = CASE WHEN customer_first_name IS NULL OR customer_first_name = 'Customer' THEN ${firstName} ELSE customer_first_name END,
                customer_reply_to = COALESCE(customer_reply_to, ${latest.address || first.address}), customer_email = COALESCE(customer_email, ${first.address}), pii_purged_at = NULL
              WHERE id = ${kase.id} AND pii_purged_at IS NOT NULL`.catch(() => {})
    if (order) await attachOrderToCase(sql, kase.id, order).catch((e) => result.skipped.push({ thread: tid, reason: `saisales: order not saved (${String(e?.message ?? e).slice(0, 80)})` }))

    const pendingTone: { id: number; text: string }[] = []
    for (const m of msgs) {
      const [exists] = await sql`SELECT 1 FROM messages WHERE gmail_message_id = ${m.id}`
      if (exists) continue
      const mine = isOurs(m)
      if (!mine && isAutomated(m)) continue
      const body = (mine ? ownWords(messageBody(m)) : customerOf(m).text).slice(0, 20000)
      if (!body) continue
      if (await alreadyImported(sql, m, kase.id, body, mine ? 'outbound' : 'inbound')) continue
      const [ins] = await sql`
        INSERT INTO messages (case_id, direction, sender, body, subject, gmail_message_id, rfc_message_id, sent_at, mailbox_id)
        VALUES (${kase.id}, ${mine ? 'outbound' : 'inbound'}, ${mine ? 'Saisales Support' : isContactFormEmail(m) ? 'Customer (website contact form)' : 'Customer'}, ${body},
                ${header(m, 'Subject') || null}, ${m.id}, ${header(m, 'Message-ID') || null}, ${new Date(Number(m.internalDate))}, ${conn.id})
        RETURNING id`
      result.messagesNew++
      await recordAttachments(sql, m, ins.id, kase.id)
      await sql`UPDATE messages SET attachments_checked_at = now() WHERE id = ${ins.id}`.catch(() => {})
      if (!mine) pendingTone.push({ id: ins.id, text: body })
      if (!mine && /\b(hot|heat|heating|overheat|burn|smok|swell|swollen|bulg)/i.test(body)) await sql`UPDATE cases SET battery_flag = TRUE WHERE id = ${kase.id}`
    }
    if (latestAt > new Date(kase.last_customer_message_at)) {
      const [r] = await sql`UPDATE cases SET last_customer_message_at = ${latestAt},
                  status = CASE WHEN status IN ('awaiting_customer', 'resolved') AND archived_at IS NULL THEN 'open' ELSE status END, updated_at = now()
                WHERE id = ${kase.id} RETURNING (status = 'open' AND ${kase.status ?? ''} = 'resolved') AS reopened`
      if (r?.reopened) await sql`INSERT INTO messages (case_id, direction, sender, body, kind, sent_at)
                  VALUES (${kase.id}, 'inbound', 'ReplyIQ', 'Reopened: the customer wrote again after the case was resolved.', 'event', now())`.catch(() => {})
    }
    if (latest.address && EMAIL.test(latest.address)) await sql`UPDATE cases SET customer_reply_to = ${latest.address} WHERE id = ${kase.id} AND customer_reply_to IS DISTINCT FROM ${latest.address}`
    for (const p of pendingTone.slice(0, 5)) {
      try {
        const [k] = await sql`SELECT * FROM cases WHERE id = ${kase.id}`
        const tone = await classifyTone(env, redactPii(p.text, k as any))
        if (tone) {
          await sql`UPDATE messages SET tone = ${tone.label}, tone_source = 'ai', tone_model = ${tone.model} WHERE id = ${p.id} AND tone_source IS DISTINCT FROM 'staff'`
          await sql`UPDATE cases SET tone = ${tone.label} WHERE id = ${kase.id}`
        }
      } catch (e) { console.error('saisales tone failed', e) }
    }
    await markSeenFor(sql, seenKey(tid))
  }
  return result
}
