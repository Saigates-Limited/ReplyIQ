// Replies while the office is closed (Saturdays, Sundays, UK bank holidays) — Sagar, 21 Nov 2026.
// Runs from the 15-minute cron when switched on (Settings → Closed-day replies). For each customer message that arrived since the
// office closed (17:00 on the last working day) and that nobody has answered:
//   • routine (low / medium stakes): the normal policy reply is written and, only if it passes every check with no warning
//     and needs no manager, it is sent as it is;
//   • high stakes (anything a manager must decide, high urgency, a failed check or a warning): a short personal holding reply
//     that makes no decision is sent, and the full draft waits for staff on the next working day.
// Replies read like any other reply from the team: they never say they are automatic.
import type { Bindings, Sql } from './db'
import { generateDraft, serverChecks, buildPayload, MODEL, type CaseRow, type MessageRow, type EventRow } from './ai'
import { loadActiveRules } from './kb'
import { loadCurrentPrompt } from './systemPrompt'
import { reviewInContext, openFindings } from './contextCheck'
import { decideManager } from './approval'
import { repeatFinding, findAlreadySent } from './sendGuards'
import { saysFileAttached } from './draftFiles'
import { statusAfterSend } from './caseOps'
import { listConnections, accessToken, sendReply } from './gmail'
import { REFUND_MAILBOX } from './returns/refunds'
import { loadHolidays, closedSpellStart, longDate, londonDate, nextWorkingDay, closedReason, type Holidays } from './closedDays'

export const CHANNELS = ['amazon', 'shopify', 'refurbed', 'ebay'] as const
export type Channel = (typeof CHANNELS)[number]
// Channels whose customer messages reach ReplyIQ today. The others can be switched on once their integration is built.
export const CONNECTED_CHANNELS: Channel[] = ['amazon']

export type AutoReplySettings = {
  enabled: boolean
  channels: Record<Channel, boolean>
  returns_note: string
  extra_closed: Record<string, string> // 'YYYY-MM-DD' → note (e.g. Christmas Eve)
}
export const DEFAULT_AUTO_REPLY: AutoReplySettings = {
  enabled: false,
  channels: { amazon: true, shopify: false, refurbed: false, ebay: false },
  returns_note: 'Our returns team remains available over the weekend and on bank holidays.',
  extra_closed: {},
}
const MAX_PER_RUN = 8
const QUIET_MINUTES = 10 // let a customer finish writing (several messages in a row) before replying

export async function getAutoReplySettings(sql: Sql): Promise<AutoReplySettings & { updated_at: string | null }> {
  try {
    const [r] = await sql`SELECT value, updated_at FROM app_settings WHERE key = 'auto_reply'`
    const v = (typeof r?.value === 'string' ? JSON.parse(r.value) : r?.value ?? {}) as Partial<AutoReplySettings>
    return {
      enabled: v.enabled === true,
      channels: { ...DEFAULT_AUTO_REPLY.channels, ...(v.channels ?? {}) },
      returns_note: typeof v.returns_note === 'string' && v.returns_note.trim() ? v.returns_note.trim() : DEFAULT_AUTO_REPLY.returns_note,
      extra_closed: v.extra_closed && typeof v.extra_closed === 'object' ? v.extra_closed : {},
      updated_at: r?.updated_at ?? null,
    }
  } catch {
    return { ...DEFAULT_AUTO_REPLY, enabled: false, updated_at: null } // fail closed: never send if the setting can't be read
  }
}

export async function saveAutoReplySettings(sql: Sql, patch: Partial<AutoReplySettings>, userId: number) {
  const cur = await getAutoReplySettings(sql)
  const extra: Record<string, string> = {}
  for (const [d, n] of Object.entries(patch.extra_closed ?? cur.extra_closed)) if (/^\d{4}-\d{2}-\d{2}$/.test(d)) extra[d] = String(n ?? '').slice(0, 60)
  const next: AutoReplySettings = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : cur.enabled,
    channels: Object.fromEntries(CHANNELS.map((ch) => [ch, typeof patch.channels?.[ch] === 'boolean' ? patch.channels[ch] : cur.channels[ch]])) as Record<Channel, boolean>,
    returns_note: typeof patch.returns_note === 'string' && patch.returns_note.trim() ? patch.returns_note.trim().slice(0, 300) : cur.returns_note,
    extra_closed: extra,
  }
  await sql`INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ('auto_reply', ${sql.json(next as any)}, ${userId}, now())
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`
  return next
}

/** Which channel a case belongs to. Only Amazon buyer messages (the marketplace relay address) are recognised today. */
export function channelOf(k: { source?: string | null; customer_reply_to?: string | null }): Channel | null {
  if (/@marketplace\.amazon\./i.test(String(k.customer_reply_to ?? ''))) return 'amazon'
  return null
}

// ───────── What to send ─────────
const SAFETY = /\b(swollen|swelling|bulging|burning|smoke|smoking|very hot|too hot|overheat)/i
// A holding reply must not decide anything. Anything that reads like a promise or an outcome falls back to the plain template.
const DECISION = /\b(we(?: will|'ll| can| have| are going to)\s+(?:\w+\s+)?(refund|replace|issue|send you|arrange|approve|offer|cover|credit|repair|collect)|you(?: will|'ll) (?:receive|get) (?:a |your |the )?(refund|replacement|credit)|full refund|partial refund|approved|accepted your|compensation|goodwill|discount|voucher)\b/i
const AUTOMATIC = /\b(auto(?:mated|matic|-?reply|-?response)|out of (?:office|hours)|this (?:is an? )?(?:automated|automatic) (?:message|reply|email))\b/i

export function holdingTemplate(k: CaseRow, reopens: string, returnsNote: string, safety: boolean) {
  const first = k.customer_first_name && k.customer_first_name !== 'Customer' ? k.customer_first_name : null
  const about = k.device_model ? `your ${k.device_model}` : k.order_id ? `your order ${k.order_id}` : 'your order'
  return [`Dear ${first ?? 'Customer'},`, '',
    `Thank you for your message about ${about}. We have read it carefully, and a member of our team will come back to you with a full answer by ${longDate(reopens)}.`,
    ...(safety ? ['', 'In the meantime, please stop using and charging the phone and keep it away from anything flammable.'] : []),
    '', returnsNote, '', 'Kind regards,', 'Customer Support Team'].join('\n')
}

export function holdingProblems(text: string): string[] {
  const p: string[] = []
  if (DECISION.test(text)) p.push('makes or hints at a decision')
  if (AUTOMATIC.test(text)) p.push('says it is automatic')
  if (text.length > 1200) p.push('too long')
  if (!/Customer Support Team\s*$/.test(text.trim())) p.push('sign-off missing')
  return p
}

async function holdingReply(env: Bindings, k: CaseRow, messages: MessageRow[], events: EventRow[], reason: string, reopens: string, returnsNote: string): Promise<{ text: string; source: 'model' | 'template'; problems: string[] }> {
  const safety = messages.some((m) => m.direction === 'inbound' && SAFETY.test(m.body)) || k.battery_flag === true
  const fallback = (problems: string[]) => ({ text: holdingTemplate(k, reopens, returnsNote, safety), source: 'template' as const, problems })
  if (!env.OPENAI_API_KEY) return fallback(['no model key'])
  const payload = buildPayload(k, messages, { events }) // same redaction as drafting: no surname, email, phone or address
  const system = `You write one short email for Saigates Customer Support to an Amazon UK buyer. Clear UK English, warm and personal, no em dashes.
The buyer's message needs a decision from a member of the team, who will reply in full by ${longDate(reopens)}. Today is ${longDate(londonDate(new Date()))}.
Write 50 to 110 words that:
- start "Dear <first name>," (or "Dear Customer," if no first name);
- show you have read their message: refer to their specific product and concern in your own words;
- make NO decision and NO promise: no refund, replacement, repair, return approval, compensation, discount or outcome, and do not say whether they are or are not entitled to anything;
- do not ask for documents, photos or personal details, and do not admit fault;
- say a member of the team will reply with a full answer by ${longDate(reopens)};
- include this sentence as written: "${returnsNote}";
- if the phone may be unsafe (swollen, hot, burning battery), tell them to stop using and charging it;
- never say or suggest the email is automatic, out of hours or an auto-reply;
- end exactly with:
Kind regards,
Customer Support Team
Return JSON: {"reply": "<the email>"}`
  const user = `CASE INPUT:\n${JSON.stringify(payload.caseInput, null, 2)}\n\nORDER TIMELINE (oldest first):\n${payload.thread.map((m) => `[${m.from} @ ${m.sent_at}]\n${m.text}`).join('\n\n')}`
  try {
    const base = (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: MODEL, store: false, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    })
    if (!res.ok) return fallback([`model error ${res.status}`])
    const data: any = await res.json()
    const text = String(JSON.parse(data.choices?.[0]?.message?.content ?? '{}').reply ?? '').trim()
    const problems = [...holdingProblems(text), ...serverChecks(text, k).filter((f) => f.severity === 'fail').map((f) => f.detail)]
    if (!text || problems.length) return fallback(problems.length ? problems : ['empty reply'])
    return { text, source: 'model', problems: [] }
  } catch (e: any) {
    return fallback([String(e?.message ?? e).slice(0, 120)])
  }
}

type Thread = { kase: CaseRow; messages: MessageRow[]; events: EventRow[] }
async function loadThread(sql: Sql, caseId: number): Promise<Thread | null> {
  const [kase] = await sql<CaseRow[]>`SELECT * FROM cases WHERE id = ${caseId}`
  if (!kase) return null
  const messages = await sql<MessageRow[]>`SELECT m.direction, m.body, m.sent_at, m.sender, m.kind, m.id FROM messages m
    WHERE m.case_id = ${caseId} AND NOT EXISTS (SELECT 1 FROM amazon_events e WHERE e.id = m.event_id AND e.kind = 'refund_initiated') AND m.sender IS DISTINCT FROM 'Amazon Refund'
    ORDER BY m.sent_at ASC`
  const atts = await sql<{ message_id: number; filename: string; mime_type: string; size_bytes: number }[]>`SELECT message_id, filename, mime_type, size_bytes FROM attachments WHERE case_id = ${caseId}`.catch(() => [] as any[])
  for (const m of messages as any[]) m.attachments = atts.filter((a) => a.message_id === m.id)
  const events = await sql<EventRow[]>`SELECT kind, status, amount, currency, received_at, deadline_at, return_reason, customer_comment, authorisation, policy_check, item_description
    FROM amazon_events WHERE case_id = ${caseId} AND kind <> 'refund_initiated' ORDER BY received_at ASC`
  return { kase, messages, events }
}

/** The normal policy reply, with the same checks and manager rules as a draft made by staff. Nothing is saved. */
async function fullReply(env: Bindings, sql: Sql, t: Thread) {
  const kbRules = await loadActiveRules(sql, 'customer')
  const promptVersion = await loadCurrentPrompt(sql)
  const { result, kbRuleIds } = await generateDraft(env, t.kase, t.messages, { events: t.events, mode: 'customer', kbRules, customPrompt: promptVersion?.body })
  const rep = repeatFinding(result.draft, t.messages as any)
  const stored = await reviewInContext(env, t.kase, t.messages, t.events, result.draft, [...serverChecks(result.draft, t.kase, 'customer'), ...(rep ? [rep] : [])])
  const findings = openFindings(stored)
  const { needsManager, reasons, urgency } = decideManager(result, t.kase, t.messages, findings, 'customer')
  const why: string[] = []
  if (findings.some((f) => f.severity === 'fail')) why.push('failed a check: ' + findings.filter((f) => f.severity === 'fail').map((f) => f.detail).join('; '))
  if (findings.some((f) => f.severity === 'warn')) why.push('warning: ' + findings.filter((f) => f.severity === 'warn').map((f) => f.detail).join('; '))
  if (needsManager) why.push('needs a manager: ' + (reasons.join(', ') || 'policy'))
  if (urgency === 'high') why.push('high urgency')
  if (saysFileAttached(result.draft)) why.push('says a file is attached')
  if (await findAlreadySent(sql, t.kase.id, result.draft)) why.push('same text already sent')
  return { result, stored, findings, needsManager, reasons, urgency, kbRuleIds, promptVersion, routine: why.length === 0, why }
}

async function insertDraft(sql: Sql, caseId: number, f: { lane: string; text: string; notes: string; check: string; findings: unknown[]; needsManager: boolean; reason: string; urgency: string; kbRuleIds?: number[]; promptVersion?: number | null; auto: 'full' | 'holding' | 'held' }) {
  const [d] = await sql`INSERT INTO drafts (case_id, tree, draft_text, original_text, staff_notes, check_result, check_findings, server_findings,
                          needs_manager, needs_manager_reason, urgency, model, created_by, mode, kb_rule_ids, system_prompt_version, auto_reply)
    VALUES (${caseId}, ${f.lane}, ${f.text}, ${f.text}, ${f.notes}, ${f.check}, ${sql.json([])}, ${sql.json(f.findings as any)},
            ${f.needsManager}, ${f.reason}, ${f.urgency}, ${MODEL}, NULL, 'customer',
            string_to_array(${(f.kbRuleIds ?? []).join(',')}, ',')::int[], ${f.promptVersion ?? null}, ${f.auto})
    RETURNING id`
  return d.id as number
}

/** Send a saved draft through the Amazon-registered mailbox, threaded on the customer's conversation. */
async function sendDraft(env: Bindings, sql: Sql, kase: CaseRow, draftId: number, text: string, opts: { setAwaiting: boolean }) {
  const conns = await listConnections(sql)
  const amazonConn = conns.find((x) => x.email_address.toLowerCase() === REFUND_MAILBOX && x.enabled)
  if (!amazonConn) throw new Error(`${REFUND_MAILBOX} is not connected or is paused`)
  const claimed = await sql`UPDATE drafts SET status = 'sending', updated_at = now() WHERE id = ${draftId} AND status = 'draft' RETURNING id`
  if (!claimed.length) throw new Error('draft already being sent')
  try {
    const [lastInbound] = await sql`SELECT subject, rfc_message_id FROM messages WHERE case_id = ${kase.id} AND direction = 'inbound' ORDER BY sent_at DESC LIMIT 1`
    const refs = await sql`SELECT rfc_message_id FROM messages WHERE case_id = ${kase.id} AND rfc_message_id IS NOT NULL ORDER BY sent_at ASC`
    const subject = lastInbound?.subject ? (/^re:/i.test(lastInbound.subject) ? lastInbound.subject : `Re: ${lastInbound.subject}`) : `Re: ${kase.subject}`
    const { token, conn } = await accessToken(env, sql, amazonConn.id)
    const sent = await sendReply(token, { from: conn.email_address, to: kase.customer_reply_to!, subject, body: text,
      inReplyTo: lastInbound?.rfc_message_id || undefined, references: refs.map((r: any) => r.rfc_message_id).join(' ') || undefined, threadId: kase.gmail_thread_id || undefined })
    await sql.begin(async (tx: any) => {
      await tx`UPDATE drafts SET status = 'sent', sent_via = 'gmail', sent_gmail_message_id = ${sent.id}, sent_recorded_at = now(), updated_at = now() WHERE id = ${draftId}`
      await tx`INSERT INTO messages (case_id, direction, sender, body, subject, gmail_message_id, sent_at)
               VALUES (${kase.id}, 'outbound', 'Saigates Support (closed-day reply)', ${text}, ${subject}, ${sent.id}, now())`
      if (opts.setAwaiting) await statusAfterSend(tx, kase.id, false, draftId)
    })
    return sent.id
  } catch (e) {
    await sql`UPDATE drafts SET status = 'draft', updated_at = now() WHERE id = ${draftId} AND status = 'sending'`
    throw e
  }
}

export type AutoReplyOutcome = { case_id: number; case_ref: string; kind: 'full' | 'holding' | 'skipped' | 'failed'; detail: string; text?: string }

/** Cases with an unanswered customer message that arrived since the office closed. */
export async function dueCases(sql: Sql, since: Date, now: Date, settings: AutoReplySettings) {
  const quiet = new Date(now.getTime() - QUIET_MINUTES * 60_000)
  const rows = await sql`
    SELECT c.id, c.case_ref, c.source, c.customer_reply_to, lm.id AS last_message_id
    FROM cases c
    JOIN LATERAL (SELECT m.id, m.direction, m.kind, m.sent_at FROM messages m WHERE m.case_id = c.id AND m.kind IS DISTINCT FROM 'event'
                  ORDER BY m.sent_at DESC, m.id DESC LIMIT 1) lm ON TRUE
    WHERE c.archived_at IS NULL AND c.gmail_thread_id IS NOT NULL AND c.customer_reply_to IS NOT NULL
      AND lm.direction = 'inbound' AND lm.kind = 'message' AND lm.sent_at >= ${since} AND lm.sent_at <= ${quiet}
      AND NOT EXISTS (SELECT 1 FROM auto_replies a WHERE a.message_id = lm.id)
      AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.case_id = c.id AND d.status IN ('sending','pending_approval','approved'))
    ORDER BY lm.sent_at ASC LIMIT 50`
  return (rows as any[]).filter((r) => { const ch = channelOf(r); return ch && settings.channels[ch] && CONNECTED_CHANNELS.includes(ch) }).slice(0, MAX_PER_RUN)
}

/**
 * One pass. dryRun: decide and write the replies but save and send nothing (Settings → Preview).
 * Each customer message is answered at most once (auto_replies.message_id is unique), and a case gets at most one holding reply per closed spell.
 */
export async function runAutoReplies(env: Bindings, sql: Sql, opts: { now?: Date; dryRun?: boolean; force?: boolean } = {}): Promise<{ closed: boolean; reason?: string; reopens?: string; outcomes: AutoReplyOutcome[] }> {
  const now = opts.now ?? new Date()
  const settings = await getAutoReplySettings(sql)
  if (!settings.enabled && !opts.dryRun) return { closed: false, outcomes: [] }
  const holidays = await loadHolidays(sql)
  const spell = closedSpellStart(now, holidays, settings.extra_closed)
  if (!spell) return { closed: false, outcomes: [] }
  const outcomes: AutoReplyOutcome[] = []
  for (const row of await dueCases(sql, spell.since, now, settings)) {
    const t = await loadThread(sql, row.id)
    if (!t) continue
    if (!opts.dryRun) {
      const claim = await sql`INSERT INTO auto_replies (case_id, message_id, kind, closed_reason) VALUES (${row.id}, ${row.last_message_id}, 'pending', ${spell.reason})
                              ON CONFLICT (message_id) DO NOTHING RETURNING id`
      if (!claim.length) continue
    }
    const record = async (o: AutoReplyOutcome, draftId: number | null = null) => {
      outcomes.push(o)
      if (!opts.dryRun) await sql`UPDATE auto_replies SET kind = ${o.kind}, detail = ${o.detail.slice(0, 1000)}, draft_id = ${draftId} WHERE message_id = ${row.last_message_id}`
    }
    try {
      const full = await fullReply(env, sql, t)
      if (full.routine) {
        if (opts.dryRun) { await record({ case_id: row.id, case_ref: row.case_ref, kind: 'full', detail: 'routine reply, all checks passed', text: full.result.draft }); continue }
        const id = await insertDraft(sql, row.id, { lane: full.result.lane, text: full.result.draft, notes: [full.result.staff_notes, `Sent automatically on ${spell.reason} (routine reply, all checks passed).`].filter(Boolean).join('\n'),
          check: 'PASS', findings: full.stored, needsManager: false, reason: '', urgency: full.urgency, kbRuleIds: full.kbRuleIds, promptVersion: full.promptVersion?.version ?? null, auto: 'full' })
        await sendDraft(env, sql, t.kase, id, full.result.draft, { setAwaiting: true })
        await record({ case_id: row.id, case_ref: row.case_ref, kind: 'full', detail: 'routine reply sent', text: full.result.draft }, id)
        continue
      }
      // High stakes: the full draft waits for staff; the customer gets one holding reply per closed spell.
      const [held] = await sql`SELECT 1 FROM auto_replies WHERE case_id = ${row.id} AND kind = 'holding' AND created_at >= ${spell.since} LIMIT 1`
      if (!opts.dryRun) {
        await insertDraft(sql, row.id, { lane: full.result.lane, text: full.result.draft,
          notes: [full.result.staff_notes, `Written on ${spell.reason}, not sent: ${full.why.join(' · ')}.${held ? '' : ' The customer was sent a holding reply.'} Review and send on ${longDate(spell.reopens)}.`].filter(Boolean).join('\n'),
          check: full.findings.some((f) => f.severity === 'fail') ? 'FAIL' : 'PASS', findings: full.stored, needsManager: full.needsManager, reason: full.reasons.join('; '),
          urgency: full.urgency, kbRuleIds: full.kbRuleIds, promptVersion: full.promptVersion?.version ?? null, auto: 'held' })
      }
      if (held) { await record({ case_id: row.id, case_ref: row.case_ref, kind: 'skipped', detail: 'holding reply already sent this weekend / holiday; full draft saved for staff' }); continue }
      const h = await holdingReply(env, t.kase, t.messages, t.events, spell.reason, spell.reopens, settings.returns_note)
      const detail = `holding reply (${full.why.join(' · ')})${h.source === 'template' ? ` · standard wording used (${h.problems.join(', ')})` : ''}`
      if (opts.dryRun) { await record({ case_id: row.id, case_ref: row.case_ref, kind: 'holding', detail, text: h.text }); continue }
      const id = await insertDraft(sql, row.id, { lane: 'holding reply', text: h.text, notes: `Sent automatically on ${spell.reason}. No decision made; full reply due ${longDate(spell.reopens)}.`,
        check: 'PASS', findings: [], needsManager: false, reason: '', urgency: full.urgency, auto: 'holding' })
      await sendDraft(env, sql, t.kase, id, h.text, { setAwaiting: false })
      await record({ case_id: row.id, case_ref: row.case_ref, kind: 'holding', detail, text: h.text }, id)
    } catch (e: any) {
      await record({ case_id: row.id, case_ref: row.case_ref, kind: 'failed', detail: String(e?.message ?? e).slice(0, 300) })
    }
  }
  return { closed: true, reason: spell.reason, reopens: spell.reopens, outcomes }
}

/** For the settings screen: today, and the closed days in the next 60 days. */
export async function closedCalendar(sql: Sql, settings: AutoReplySettings, now = new Date()) {
  const holidays: Holidays = await loadHolidays(sql)
  const today = londonDate(now)
  const upcoming: { date: string; label: string; reason: string }[] = []
  let d = today
  for (let i = 0; i < 60; i++) {
    const r = closedReason(d, holidays, settings.extra_closed)
    if (r && r !== 'Saturday' && r !== 'Sunday') upcoming.push({ date: d, label: longDate(d), reason: r })
    d = nextDay(d)
  }
  const spell = closedSpellStart(now, holidays, settings.extra_closed)
  return { today, closed_now: !!spell, reason: spell?.reason ?? null, reopens: spell ? longDate(spell.reopens) : null, next_working_day: longDate(nextWorkingDay(today, holidays, settings.extra_closed)), upcoming }
}
const nextDay = (ymd: string) => { const x = new Date(ymd + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10) }
