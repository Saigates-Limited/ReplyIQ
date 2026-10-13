// Carrier desk database layer: opening investigations from customer cases, ingesting carrier email,
// keeping each parcel's status current, and preparing (never sending) the next email.
import type { Bindings, Sql } from '../db'
import { CARRIERS, normaliseCarrier, normaliseTracking, carrierOfTracking, findTrackings, carrierFromAddress, type CarrierId } from './carriers'
import { classifyCarrierEmail, topOfEmail, inboundLabel, type InboundKind } from './classify'
import { compose, type DraftKind, type Facts } from './templates'
import { onInbound, onOutbound, displayStatus, waitingDays, suggestedDraft, CLOSED_STATUSES, type CarrierCaseRow, type Patch } from './engine'
import { detectCarrierIssue, ISSUE_LABEL, type CarrierIssue } from './detect'
import { londonDate } from './workdays'
import { accessToken, listConnections, listThreadIds, getThread, header, messageBody, GmailQuotaError, type GmailConnection, type GmailMessage } from '../gmail'
import { fetchOrder, spapiConfigured, type SpapiEnv, type OrderSummary } from '../spapi'

// ───────── Settings ─────────
export type CarrierSettings = {
  send_mailbox_id: number | null // which connected Gmail account sends carrier mail (null → first carrier mailbox, else default)
  from_address: string | null // optional "Send mail as" alias, e.g. ecom@saigates.com
  from_name: string
  cc: string[]
  signature: string
  addresses: Partial<Record<CarrierId, string>> // overrides for CARRIERS[x].investigationTo
  auto_open: boolean // sync opens a "Ready to raise" carrier case when a customer reports a delivery problem
  auto_chase: boolean // cron prepares a chase draft when the carrier's reply is overdue
  extra_allowed_domains: string[] // carrier emails may only go to carrier domains (+ these)
}
export const DEFAULT_SETTINGS: CarrierSettings = {
  send_mailbox_id: null,
  from_address: null,
  from_name: 'Saigates Ltd',
  cc: [],
  signature: 'Saigates Ltd\n98 High Street\nWolverhampton\nWV11 1SZ\nw: https://saigates.com\ne: ecom@saigates.com',
  addresses: {},
  auto_open: true,
  auto_chase: true,
  extra_allowed_domains: [],
}
export async function getSettings(sql: Sql): Promise<CarrierSettings> {
  const [r] = await sql`SELECT value FROM app_settings WHERE key = 'carrier'`.catch(() => [] as any[])
  return { ...DEFAULT_SETTINGS, ...((r?.value as Partial<CarrierSettings>) ?? {}) }
}
export async function saveSettings(sql: Sql, patch: Partial<CarrierSettings>, userId: number) {
  const next = { ...(await getSettings(sql)), ...patch }
  await sql`INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ('carrier', ${sql.json(next as any)}, ${userId}, now())
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`
  return next
}
export const carrierAddress = (s: CarrierSettings, c: CarrierId) => s.addresses[c] || CARRIERS[c].investigationTo

const CARRIER_DOMAINS = ['royalmail.com', 'dpd.co.uk', 'dpd.uk', 'dpdgroup.co.uk', 'fedex.com', 'evri.com', 'parcelforce.co.uk']
/** Carrier emails may only be sent to a carrier's own domain (or a domain a manager added in Settings). */
export function recipientAllowed(addr: string, s: CarrierSettings) {
  const m = addr.trim().toLowerCase().match(/^[^@\s<>]+@([a-z0-9.-]+\.[a-z]{2,})$/)
  if (!m) return false
  const dom = m[1]
  return [...CARRIER_DOMAINS, ...s.extra_allowed_domains.map((d) => d.toLowerCase())].some((d) => dom === d || dom.endsWith(`.${d}`))
}

// ───────── Reads ─────────
const ISSUES: CarrierIssue[] = ['lost', 'delivered_not_received', 'empty_parcel', 'damaged', 'wrong_item', 'pod_request', 'return_to_sender', 'postage_refund', 'other']
export const isIssue = (v: unknown): v is CarrierIssue => ISSUES.includes(v as CarrierIssue)

export async function loadCarrierCase(sql: Sql, id: number) {
  const [k] = await sql`SELECT cc.*, c.case_ref, c.subject AS case_subject, c.customer_first_name FROM carrier_cases cc LEFT JOIN cases c ON c.id = cc.case_id WHERE cc.id = ${id}`
  return k as any
}

/** Facts for a template: the carrier case, plus the customer case (name/address go to the CARRIER only) and the Amazon order cache. */
export async function factsFor(sql: Sql, k: any, staffName: string, settings: CarrierSettings): Promise<Facts> {
  const [kase] = k.case_id ? await sql`SELECT customer_first_name, customer_last_name, customer_address, device_model, order_id FROM cases WHERE id = ${k.case_id}` : [null]
  const [lastIn] = await sql`SELECT summary FROM carrier_messages WHERE carrier_case_id = ${k.id} AND direction = 'inbound' AND kind = 'info_request' ORDER BY sent_at DESC LIMIT 1`
  const recipientName = kase && kase.customer_first_name && kase.customer_first_name !== 'Customer' ? [kase.customer_first_name, kase.customer_last_name].filter(Boolean).join(' ') : null
  return {
    carrier: k.carrier,
    tracking: k.tracking,
    orderId: k.order_id ?? kase?.order_id ?? null,
    issue: k.issue,
    product: k.product ?? kase?.device_model ?? null,
    service: k.service,
    value: k.value != null ? Number(k.value) : null,
    postedOn: k.posted_on ? londonDate(new Date(k.posted_on)) : null,
    deliveredOn: k.delivered_on ? londonDate(new Date(k.delivered_on)) : null,
    lastScan: null,
    recipientName,
    recipientAddress: kase?.customer_address ?? null,
    carrierRefs: k.carrier_refs ?? [],
    claimRef: k.claim_ref,
    raisedAt: k.raised_at ? new Date(k.raised_at).toISOString() : null,
    lastUsAt: k.last_us_at ? new Date(k.last_us_at).toISOString() : null,
    workingDaysWaiting: waitingDays(k),
    carrierAsked: lastIn?.summary ?? null,
    claimed: k.claimed != null ? Number(k.claimed) : null,
    staffName,
    signature: settings.signature,
  }
}

// ───────── Writes ─────────
const PATCH_COLS = ['status', 'carrier_refs', 'claim_ref', 'raised_at', 'last_us_at', 'last_carrier_at', 'carrier_reply_type', 'sla_due_at', 'paid', 'paid_on', 'claimed', 'next_action', 'next_due', 'closed_at'] as const
export async function applyPatch(sql: Sql, id: number, p: Patch & { customer_update_due?: boolean; gmail_thread_id?: string; mailbox_id?: number | null; delivered_on?: string }) {
  const cols = Object.keys(p).filter((k) => (PATCH_COLS as readonly string[]).includes(k) || ['customer_update_due', 'gmail_thread_id', 'mailbox_id', 'delivered_on'].includes(k)) as (keyof typeof p)[]
  if (!cols.length) return
  // carrier_refs is JSONB (postgres.js runs with fetch_types:false on Workers, so native arrays would come back as strings)
  await sql.unsafe(`UPDATE carrier_cases SET ${cols.map((c, i) => `${c} = $${i + 2}${c === 'carrier_refs' ? '::text::jsonb' : ''}`).join(', ')} WHERE id = $1`,
    [id, ...cols.map((c) => (c === 'carrier_refs' ? JSON.stringify((p as any)[c] ?? []) : (p as any)[c]))] as any[])
}

/** Create (or return the live) draft of one kind for a parcel. `regenerate` discards the live one first. */
export async function prepareDraft(sql: Sql, ccId: number, kind: DraftKind, staff: { id: number | null; name: string }, opts: { auto?: boolean; regenerate?: boolean } = {}) {
  const [live] = await sql`SELECT id FROM carrier_drafts WHERE carrier_case_id = ${ccId} AND kind = ${kind} AND status IN ('draft','approved')`
  if (live && !opts.regenerate) return { id: live.id as number, existing: true }
  if (live) await sql`UPDATE carrier_drafts SET status = 'discarded' WHERE id = ${live.id}`
  const k = await loadCarrierCase(sql, ccId)
  const settings = await getSettings(sql)
  const facts = await factsFor(sql, k, staff.name, settings)
  const c = compose(kind, facts, kind === 'claim_pack' ? null : carrierAddress(settings, k.carrier))
  // Follow-ups reply to the carrier's own latest email (their subject carries the case reference they route by)
  if (kind === 'chase' || kind === 'info_reply' || kind === 'challenge') {
    const [theirs] = await sql`SELECT subject, from_addr FROM carrier_messages WHERE carrier_case_id = ${ccId} AND direction = 'inbound' AND subject IS NOT NULL
                               AND kind NOT IN ('notification') ORDER BY sent_at DESC LIMIT 1`
    if (theirs?.subject && /case reference|case number|#\d{7,}/i.test(theirs.subject)) c.subject = /^re:/i.test(theirs.subject) ? theirs.subject : `RE: ${theirs.subject}`
  }
  const [d] = await sql`INSERT INTO carrier_drafts (carrier_case_id, kind, to_address, subject, body, original_body, missing, needs_manager, auto_created, created_by)
    VALUES (${ccId}, ${kind}, ${c.to}, ${c.subject}, ${c.body}, ${c.body}, ${sql.json(c.missing)}, ${c.needsManager}, ${!!opts.auto}, ${staff.id})
    ON CONFLICT DO NOTHING RETURNING id`
  if (!d) {
    const [again] = await sql`SELECT id FROM carrier_drafts WHERE carrier_case_id = ${ccId} AND kind = ${kind} AND status IN ('draft','approved','sending')`
    return { id: again.id as number, existing: true }
  }
  return { id: d.id as number, existing: false }
}

/** Mirror carrier news onto the customer's case timeline (no personal data: summary only). */
async function mirrorToCustomerCase(sql: Sql, k: any, text: string, at: Date) {
  if (!k.case_id) return
  await sql`INSERT INTO messages (case_id, direction, sender, body, sent_at, kind)
            VALUES (${k.case_id}, 'inbound', ${`Carrier update · ${CARRIERS[k.carrier as CarrierId].label}`}, ${text.slice(0, 2000)}, ${at}, 'event')`
}

/** Facts from the Amazon order (cached by the SP-API route for 6 h) for a customer case. Never throws. */
async function orderFacts(env: Bindings, sql: Sql, orderId: string | null): Promise<OrderSummary | null> {
  if (!orderId || !/^\d{3}-\d{7}-\d{7}$/.test(orderId)) return null
  try {
    const [cached] = await sql`SELECT payload FROM amazon_orders WHERE order_id = ${orderId} AND fetched_at > now() - INTERVAL '6 hours'`
    if (cached) return cached.payload as OrderSummary
    if (!spapiConfigured(env as SpapiEnv)) {
      const [old] = await sql`SELECT payload FROM amazon_orders WHERE order_id = ${orderId}`
      return (old?.payload as OrderSummary) ?? null
    }
    const s = await fetchOrder(env as SpapiEnv, orderId)
    await sql`INSERT INTO amazon_orders (order_id, payload, fetched_at) VALUES (${orderId}, ${sql.json(s as any)}, now()) ON CONFLICT (order_id) DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now()`
    return s
  } catch (e) {
    console.error('carrier: order fetch failed', orderId, (e as Error).message)
    return null
  }
}

export type OpenResult =
  | { ok: true; carrier_case_id: number; draft_id: number | null; created: boolean }
  | { ok: false; error: string; code: 'no_tracking' | 'no_carrier' | 'too_early' | 'not_found'; promised?: string | null }

/**
 * Customer case → carrier case + investigation draft. Pulls carrier, tracking, ship date, item and price from the case
 * and the Amazon order. For "not arrived", waits until Amazon's promised delivery date has passed unless `force`.
 */
export async function openInvestigation(env: Bindings, sql: Sql, args: { caseId: number; carrier?: string | null; tracking?: string | null; issue?: string | null; force?: boolean; source?: 'customer_message' | 'manual' }, staff: { id: number | null; name: string }): Promise<OpenResult> {
  const [kase] = await sql`SELECT * FROM cases WHERE id = ${args.caseId}`
  if (!kase) return { ok: false, error: 'Case not found', code: 'not_found' }
  const order = await orderFacts(env, sql, kase.order_id)
  const tracking = normaliseTracking(args.tracking || kase.tracking_number || order?.trackingNumber || '') || null
  if (!tracking) return { ok: false, error: 'No tracking number on this case or the Amazon order. Add it in Case details first.', code: 'no_tracking' }
  const carrier = normaliseCarrier(args.carrier || kase.carrier || order?.carrier) ?? carrierOfTracking(tracking)
  if (!carrier) return { ok: false, error: 'Could not tell which carrier this is. Set the Carrier field first.', code: 'no_carrier' }
  const issue: CarrierIssue = isIssue(args.issue) ? args.issue : isIssue(kase.carrier_issue) ? kase.carrier_issue : 'lost'
  const promised = order?.promisedDelivery?.latest ?? null
  if (!args.force && issue === 'lost' && !order?.deliveredAt && promised && new Date(promised) > new Date())
    return { ok: false, error: `Not due yet: Amazon promised delivery by ${londonDate(new Date(promised))}. Open the investigation anyway?`, code: 'too_early', promised }

  const item = order?.items?.[0]
  const value = item?.unitPrice ? Number(item.unitPrice) * (item.quantity || 1) : order?.grandTotal ? Number(order.grandTotal) : null
  const postedOn = order?.shipDate ? londonDate(new Date(order.shipDate)) : null
  const deliveredOn = order?.deliveredAt ? londonDate(new Date(order.deliveredAt)) : null
  const [row] = await sql`
    INSERT INTO carrier_cases (case_id, carrier, tracking, order_id, issue, status, product, value, posted_on, delivered_on, source, created_by, next_action)
    VALUES (${kase.id}, ${carrier}, ${tracking}, ${kase.order_id}, ${issue}, 'to_raise', ${item?.title ?? kase.device_model ?? null}, ${value}, ${postedOn}, ${deliveredOn},
            ${args.source ?? 'manual'}, ${staff.id}, ${`Send ${CARRIERS[carrier].short} investigation`})
    ON CONFLICT (carrier, tracking) WHERE tracking IS NOT NULL DO UPDATE SET case_id = COALESCE(carrier_cases.case_id, EXCLUDED.case_id),
      order_id = COALESCE(carrier_cases.order_id, EXCLUDED.order_id), product = COALESCE(carrier_cases.product, EXCLUDED.product),
      value = COALESCE(carrier_cases.value, EXCLUDED.value), posted_on = COALESCE(carrier_cases.posted_on, EXCLUDED.posted_on),
      delivered_on = COALESCE(carrier_cases.delivered_on, EXCLUDED.delivered_on)
    RETURNING id, (xmax = 0) AS created, status`
  if (!kase.tracking_number || !kase.carrier)
    await sql`UPDATE cases SET tracking_number = COALESCE(tracking_number, ${tracking}), carrier = COALESCE(carrier, ${CARRIERS[carrier].label}) WHERE id = ${kase.id}`
  let draftId: number | null = null
  if (row.status === 'to_raise') draftId = (await prepareDraft(sql, row.id, 'investigation', staff)).id
  return { ok: true, carrier_case_id: row.id, draft_id: draftId, created: row.created }
}

/** Called by the customer sync for each new customer message: flag the issue, and (setting) open a "Ready to raise" case. */
export async function onCustomerMessage(env: Bindings, sql: Sql, caseId: number, text: string, at: Date) {
  const det = detectCarrierIssue(text)
  if (!det) return null
  await sql`UPDATE cases SET carrier_issue = ${det.issue}, carrier_issue_at = ${at} WHERE id = ${caseId}`.catch(() => {})
  const settings = await getSettings(sql).catch(() => DEFAULT_SETTINGS)
  if (!settings.auto_open) return det
  const [existing] = await sql`SELECT 1 FROM carrier_cases WHERE case_id = ${caseId} AND status NOT IN ('closed','rejected','paid','partially_paid')`.catch(() => [] as any[])
  if (existing) return det
  // Not-yet-due "lost" reports stay as a hint on the case; staff can still open the investigation by hand.
  await openInvestigation(env, sql, { caseId, issue: det.issue, source: 'customer_message' }, { id: null, name: settings.from_name }).catch((e) => console.error('carrier auto-open failed', e))
  return det
}

// ───────── Inbound carrier mail ─────────
/** Issue type from the subject of an investigation email we sent outside ReplyIQ. */
export function issueFromSubject(subject: string): CarrierIssue {
  const s = subject.toLowerCase()
  if (/empty|contents? missing|missing contents/.test(s)) return 'empty_parcel'
  if (/delivered.{0,40}not received|location confirmation|delivery location|wrong address/.test(s)) return 'delivered_not_received'
  if (/damaged/.test(s)) return 'damaged'
  if (/proof of delivery|\bpod\b/.test(s)) return 'pod_request'
  if (/return(?:ed)? to sender|stop and return/.test(s)) return 'return_to_sender'
  if (/postage refund|late (?:special )?delivery|guaranteed/.test(s)) return 'postage_refund'
  if (/no tracking|not (?:been )?delivered|lost|missing|whereabouts|not arrived|no update/.test(s)) return 'lost'
  return 'other'
}

const ORDER_RE = /\b(\d{3}-\d{7}-\d{7})\b|\b(PO-\d{3}-\d{8,20})\b/

async function findCarrierCase(sql: Sql, carrier: CarrierId | null, trackings: string[], caseRefs: string[], threadId: string, mailboxId: number | null) {
  for (const t of trackings) {
    const [k] = await sql`SELECT * FROM carrier_cases WHERE tracking = ${t} ORDER BY (carrier = ${carrier ?? 'other'}) DESC LIMIT 1`
    if (k) return k
  }
  if (caseRefs.length) {
    const [k] = await sql`SELECT * FROM carrier_cases WHERE carrier_refs ?| string_to_array(${caseRefs.join(',')}, ',') ORDER BY id DESC LIMIT 1`
    if (k) return k
  }
  const [k] = await sql`SELECT cc.* FROM carrier_messages m JOIN carrier_cases cc ON cc.id = m.carrier_case_id
                        WHERE m.gmail_thread_id = ${threadId} AND m.mailbox_id IS NOT DISTINCT FROM ${mailboxId} ORDER BY m.sent_at DESC LIMIT 1`
  return k ?? null
}

/** Ingest one carrier email (inbound from a carrier, or our own email to a carrier sent outside ReplyIQ). */
export async function ingestCarrierMessage(sql: Sql, m: GmailMessage, conn: GmailConnection, ourEmails: string[]): Promise<'new' | 'dup' | 'skip'> {
  const [dup] = await sql`SELECT 1 FROM carrier_messages WHERE gmail_message_id = ${m.id}`
  if (dup) return 'dup'
  const rfc = header(m, 'Message-ID') || null
  if (rfc) { const [d2] = await sql`SELECT 1 FROM carrier_messages WHERE rfc_message_id = ${rfc}`; if (d2) return 'dup' }
  const fromRaw = header(m, 'From'), toRaw = header(m, 'To'), subject = header(m, 'Subject') || ''
  const fromAddr = (fromRaw.match(/<([^>]+)>/)?.[1] ?? fromRaw).trim().toLowerCase()
  const toAddr = (toRaw.match(/<([^>]+)>/)?.[1] ?? toRaw.split(',')[0] ?? '').trim().toLowerCase()
  const body = messageBody(m)
  const at = new Date(Number(m.internalDate))
  const ours = ourEmails.some((e) => e.toLowerCase() === fromAddr) || (m.labelIds ?? []).includes('SENT') || /@saigates\.com$/.test(fromAddr)
  const carrierAddr = ours ? toAddr : fromAddr
  const carrier = carrierFromAddress(carrierAddr) ?? carrierFromAddress(`${toRaw} ${header(m, 'Cc')}`)
  if (!carrier) return 'skip'

  const cls = ours ? null : classifyCarrierEmail(fromAddr, subject, body)
  const trackings = cls?.trackings ?? findTrackings(`${subject}\n${topOfEmail(body)}`, carrier).map((t) => t.tracking)
  const caseRefs = cls?.caseRefs ?? []
  let k: any = await findCarrierCase(sql, carrier, trackings, caseRefs, m.threadId, conn.id)

  if (!k) {
    // Only start a parcel from carrier mail when it is clearly about one parcel and it matters (not a tracking notification).
    if (!trackings.length || (cls && (cls.kind === 'notification' || cls.kind === 'other' || cls.kind === 'auto_ack'))) return 'skip'
    const orderMatch = `${subject}\n${body}`.match(ORDER_RE)
    const orderId = orderMatch?.[1] ?? orderMatch?.[2] ?? null
    const [kase] = orderId
      ? await sql`SELECT id FROM cases WHERE order_id = ${orderId} ORDER BY id LIMIT 1`
      : await sql`SELECT id FROM cases WHERE upper(replace(tracking_number, ' ', '')) = ${trackings[0]} ORDER BY id LIMIT 1`
    ;[k] = await sql`INSERT INTO carrier_cases (case_id, carrier, tracking, order_id, issue, status, source, next_action)
      VALUES (${kase?.id ?? null}, ${carrier}, ${trackings[0]}, ${orderId}, ${issueFromSubject(subject)}, 'awaiting_carrier', 'carrier_email', 'Check the issue type and value')
      ON CONFLICT (carrier, tracking) WHERE tracking IS NOT NULL DO UPDATE SET updated_at = now() RETURNING *`
  }

  const kind: string = ours ? (k.raised_at ? 'chase' : 'investigation') : cls!.kind
  const summary = ours ? `We emailed ${CARRIERS[carrier].label}: ${subject.slice(0, 100)}` : cls!.summary
  await sql`INSERT INTO carrier_messages (carrier_case_id, direction, kind, from_addr, to_addr, subject, body, summary, extracted, gmail_message_id, rfc_message_id, gmail_thread_id, mailbox_id, sent_at)
    VALUES (${k.id}, ${ours ? 'outbound' : 'inbound'}, ${kind}, ${fromAddr}, ${toAddr}, ${subject.slice(0, 500)}, ${topOfEmail(body).slice(0, 20000)}, ${summary},
            ${sql.json({ caseRefs, trackings, claimRef: cls?.claimRef ?? null, amount: cls?.amount ?? null })}, ${m.id}, ${rfc}, ${m.threadId}, ${conn.id}, ${at})
    ON CONFLICT (gmail_message_id) DO NOTHING`

  // Status: only move forward on mail newer than what we already know (imports can arrive out of order)
  const latestKnown = Math.max(k.last_us_at ? +new Date(k.last_us_at) : 0, k.last_carrier_at ? +new Date(k.last_carrier_at) : 0)
  if (ours) {
    if (+at >= latestKnown && !CLOSED_STATUSES.includes(k.status)) await applyPatch(sql, k.id, onOutbound(k, kind as DraftKind, at))
    else await applyPatch(sql, k.id, { raised_at: k.raised_at ?? at })
  } else {
    const fresh = +at >= latestKnown
    const patch: any = fresh || cls!.kind === 'auto_ack' ? onInbound(k, cls!.kind, at, { caseRefs, claimRef: cls!.claimRef, amount: cls!.amount }) : { carrier_refs: [...new Set([...(k.carrier_refs ?? []), ...caseRefs])] }
    // News the customer should hear about (only from a fresh email, so a backfill doesn't re-raise old news)
    if (fresh && k.case_id && ['decision_lost', 'decision_delivered'].includes(cls!.kind)) patch.customer_update_due = true
    patch.gmail_thread_id = m.threadId
    patch.mailbox_id = conn.id
    await applyPatch(sql, k.id, patch)
    // Customer timeline: decisions and meaningful replies (not auto-acks or tracking notifications)
    // (claims, payouts and requests for information are between us and the carrier, so they stay off the customer timeline)
    if (fresh && ['holding_reply', 'decision_lost', 'decision_delivered', 'escalation'].includes(cls!.kind)) await mirrorToCustomerCase(sql, k, customerFacing(cls!.kind, carrier, k.tracking, cls!.amount), at)
  }
  return 'new'
}

/** What the customer-case timeline (and the drafting AI) sees. Facts only, no carrier staff names, no addresses. */
function customerFacing(kind: InboundKind, carrier: CarrierId, tracking: string | null, amount: number | null) {
  const c = CARRIERS[carrier].label
  const t = tracking ? ` (${tracking})` : ''
  switch (kind) {
    case 'holding_reply': return `${c} is investigating the parcel${t} and has asked its delivery office for details.`
    case 'info_request': return `${c} asked us for more information about the parcel${t}. Internal step; nothing to tell the customer yet.`
    case 'decision_lost': return `${c} has confirmed the parcel${t} could not be traced and is treated as lost. We are submitting a claim to ${c}.`
    case 'decision_delivered': return `${c} says the parcel${t} was delivered (proof of delivery / GPS on their system).`
    case 'decision_rejected': return `${c} has declined our investigation or claim for the parcel${t}.`
    case 'claim_settled': return `${c} has settled our claim for the parcel${t}${amount != null ? ` (£${amount.toFixed(2)} paid to us)` : ''}. Internal: this is between us and ${c}.`
    case 'escalation': return `${c} has escalated our case about the parcel${t} for a second review.`
    default: return `${c} replied about the parcel${t}.`
  }
}

/** Poll every mailbox flagged for carrier mail. Read-only against Gmail. */
export async function syncCarrierMail(env: Bindings, sql: Sql, opts: { lookbackDays?: number } = {}) {
  const all = await listConnections(sql)
  const targets = all.filter((c) => c.enabled && c.carrier_mail)
  const settings = await getSettings(sql)
  const ourEmails = [...all.map((c) => c.email_address), ...(settings.from_address ? [settings.from_address] : [])]
  const q = `(${Object.values(CARRIERS).map((c) => c.gmailQuery).filter(Boolean).join(' OR ')}) newer_than:${opts.lookbackDays ?? 1}d`
  const out = { mailboxes: targets.length, threads: 0, messagesNew: 0, skipped: 0, rateLimited: false, errors: [] as string[] }
  for (const conn of targets) {
    try {
      const { token } = await accessToken(env, sql, conn.id)
      const ids = await listThreadIds(token, q, opts.lookbackDays ? 300 : 60)
      const seenKey = (t: string) => `carrier:${conn.id}:${t}`
      const seen = new Set((await sql`SELECT thread_id FROM gmail_threads_seen WHERE thread_id = ANY(string_to_array(${ids.map(seenKey).join(',')}, ','))`).map((r: any) => r.thread_id))
      // Bulk imports skip finished threads; the normal poll re-reads recent ones (a reply may have landed on a seen thread)
      const todo = opts.lookbackDays ? ids.filter((t) => !seen.has(seenKey(t))) : ids
      for (const tid of todo.slice(0, 12)) {
        let thread
        try { thread = await getThread(token, tid) } catch (e) { if (e instanceof GmailQuotaError) { out.rateLimited = true; break } throw e }
        out.threads++
        for (const m of thread.messages.sort((a, b) => Number(a.internalDate) - Number(b.internalDate))) {
          const r = await ingestCarrierMessage(sql, m, conn, ourEmails)
          if (r === 'new') out.messagesNew++
          else if (r === 'skip') out.skipped++
        }
        await sql`INSERT INTO gmail_threads_seen (thread_id) VALUES (${seenKey(tid)}) ON CONFLICT (thread_id) DO UPDATE SET seen_at = now()`
      }
    } catch (e: any) {
      out.errors.push(`${conn.email_address}: ${String(e?.message ?? e).slice(0, 200)}`)
    }
  }
  return out
}

/** Cron housekeeping (database only, never sends): prepare the next email for every parcel that needs one. */
export async function prepareDueDrafts(sql: Sql) {
  const settings = await getSettings(sql)
  const open = await sql`SELECT * FROM carrier_cases WHERE status NOT IN ('paid','partially_paid','rejected','closed')`
  let made = 0
  for (const k of open as any[]) {
    const kind = suggestedDraft(k as CarrierCaseRow)
    if (!kind || kind === 'info_reply') continue // info replies need a person to write the answer
    if (kind === 'chase' && !settings.auto_chase) continue
    if (kind === 'investigation' && !k.tracking) continue
    const r = await prepareDraft(sql, k.id, kind, { id: null, name: settings.from_name }, { auto: true })
    if (!r.existing) made++
  }
  return { prepared: made }
}

// ───────── Listing ─────────
export function decorate(k: any, now = new Date()) {
  const ds = displayStatus(k, now)
  return {
    ...k,
    display_status: ds,
    issue_label: ISSUE_LABEL[k.issue as CarrierIssue] ?? k.issue,
    carrier_label: CARRIERS[k.carrier as CarrierId]?.label ?? k.carrier,
    waiting_working_days: k.last_us_at ? waitingDays(k, now) : null,
    suggested_draft: suggestedDraft(k, now),
  }
}

export { inboundLabel }
