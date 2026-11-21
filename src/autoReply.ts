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
import { repeatFinding, findAlreadySent, repeatedFromEarlier } from './sendGuards'
import { saysFileAttached } from './draftFiles'
import { statusAfterSend } from './caseOps'
import { listConnections, accessToken, sendReply } from './gmail'
import { REFUND_MAILBOX } from './returns/refunds'
import { loadHolidays, closedSpellStart, longDate, londonDate, nextWorkingDay, closedReason, inReplyWindow, holdingPlan, type Holidays } from './closedDays'

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

export function holdingTemplate(k: CaseRow, reopens: string, returnsNote: string, safety: boolean, followUp = false) {
  const first = k.customer_first_name && k.customer_first_name !== 'Customer' ? k.customer_first_name : null
  const about = k.device_model ? `your ${k.device_model}` : k.order_id ? `your order ${k.order_id}` : 'your order'
  return [`Dear ${first ?? 'Customer'},`, '',
    followUp
      ? `Thank you for your further message about ${about}. We have added it to your case, and the team member looking into it will reply with a full answer by ${longDate(reopens)}.`
      : `Thank you for your message about ${about}. We have read it carefully, and a member of our team will come back to you with a full answer by ${longDate(reopens)}.`,
    ...(safety ? ['', 'In the meantime, please stop using and charging the phone and keep it away from anything flammable.'] : []),
    '', returnsNote, '', 'Kind regards,', 'Customer Support Team'].join('\n')
}

export function holdingProblems(text: string, earlier: { body: string; sent_at: any }[] = [], returnsNote = ''): string[] {
  const p: string[] = []
  const reps = repeatedFromEarlier(text, earlier).filter((r) => !returnsNote || !r.sentence.includes(returnsNote.slice(0, 40)))
  if (reps.length) p.push('repeats an earlier reply')
  if (DECISION.test(text)) p.push('makes or hints at a decision')
  if (AUTOMATIC.test(text)) p.push('says it is automatic')
  if (text.length > 1200) p.push('too long')
  if (!/Customer Support Team\s*$/.test(text.trim())) p.push('sign-off missing')
  return p
}

async function holdingReply(env: Bindings, k: CaseRow, messages: MessageRow[], events: EventRow[], reason: string, reopens: string, returnsNote: string): Promise<{ text: string; source: 'model' | 'template'; problems: string[] }> {
  const safety = messages.some((m) => m.direction === 'inbound' && SAFETY.test(m.body)) || k.battery_flag === true
  const earlier = messages.filter((m) => m.direction === 'outbound' && m.kind !== 'event')
  const followUp = earlier.some((m) => /closed-day reply/.test(String(m.sender ?? '')))
  const fallback = (problems: string[]) => ({ text: holdingTemplate(k, reopens, returnsNote, safety, followUp), source: 'template' as const, problems })
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
- never say or suggest the email is automatic, out of hours or an auto-reply;${followUp ? `
- we have already replied once to say a full answer is coming: acknowledge their NEW message specifically and do not repeat any sentence from our earlier replies (except the returns sentence above);` : ''}
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
    const problems = [...holdingProblems(text, earlier, returnsNote), ...serverChecks(text, k).filter((f) => f.severity === 'fail').map((f) => f.detail)]
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

export type AutoReplyOutcome = { case_id: number; case_ref: string; kind: 'full' | 'holding' | 'scheduled' | 'staff' | 'superseded' | 'skipped' | 'failed'; detail: string; text?: string; send_at?: string }

/** Cases whose latest message is a customer message, unanswered, that arrived since the office closed and has not been looked at yet. */
export async function dueCases(sql: Sql, since: Date, now: Date, settings: AutoReplySettings) {
  const quiet = new Date(now.getTime() - QUIET_MINUTES * 60_000)
  const rows = await sql`
    SELECT c.id, c.case_ref, c.source, c.customer_reply_to, lm.id AS last_message_id, lm.sent_at AS last_message_at
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

const fmtLondon = (d: Date) => d.toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

/**
 * One pass, from the 15-minute cron. Replies go out only between 09:00 and 17:00 on a closed day (dryRun ignores the hours).
 * - New customer message, routine: the full reply is sent now.
 * - New customer message, high stakes: the full draft is saved for staff. If staff are back with time to spare before the 48-hour
 *   deadline, nothing is sent; otherwise a holding reply is scheduled for the latest 09:00–16:45 slot at least an hour before the deadline.
 * - A scheduled holding reply whose time has come is sent, unless the customer wrote again (that message is handled on its own)
 *   or someone already replied.
 * Each customer message is handled once (auto_replies.message_id is unique).
 */
export async function runAutoReplies(env: Bindings, sql: Sql, opts: { now?: Date; dryRun?: boolean } = {}): Promise<{ closed: boolean; reason?: string; reopens?: string; in_window?: boolean; outcomes: AutoReplyOutcome[] }> {
  const now = opts.now ?? new Date()
  const settings = await getAutoReplySettings(sql)
  if (!settings.enabled && !opts.dryRun) return { closed: false, outcomes: [] }
  const holidays = await loadHolidays(sql)
  const spell = closedSpellStart(now, holidays, settings.extra_closed)
  if (!spell) return { closed: false, outcomes: [] }
  const inWindow = inReplyWindow(now, holidays, settings.extra_closed)
  const base = { closed: true, reason: spell.reason, reopens: spell.reopens, in_window: inWindow }
  if (!inWindow && !opts.dryRun) return { ...base, outcomes: [] }
  const outcomes: AutoReplyOutcome[] = []
  const later = new Set<number>() // dry run: holding replies not due yet

  const sendHolding = async (row: { id: number; case_ref: string; message_id: number }, t: Thread, why: string, deadline: Date) => {
    const h = await holdingReply(env, t.kase, t.messages, t.events, spell.reason, spell.reopens, settings.returns_note)
    const detail = `holding reply (${why}), 48-hour deadline ${fmtLondon(deadline)}${h.source === 'template' ? ` · standard wording used (${h.problems.join(', ')})` : ''}`
    if (opts.dryRun) return { case_id: row.id, case_ref: row.case_ref, kind: 'holding' as const, detail, text: h.text }
    const id = await insertDraft(sql, row.id, { lane: 'holding reply', text: h.text, notes: `Sent automatically on ${spell.reason}. No decision made; full reply due ${longDate(spell.reopens)}.`,
      check: 'PASS', findings: [], needsManager: false, reason: '', urgency: 'normal', auto: 'holding' })
    await sendDraft(env, sql, t.kase, id, h.text, { setAwaiting: false })
    await sql`UPDATE auto_replies SET kind = 'holding', detail = ${detail.slice(0, 1000)}, draft_id = ${id} WHERE message_id = ${row.message_id}`
    return { case_id: row.id, case_ref: row.case_ref, kind: 'holding' as const, detail, text: h.text }
  }

  // 1. New customer messages.
  for (const row of await dueCases(sql, spell.since, now, settings)) {
    const t = await loadThread(sql, row.id)
    if (!t) continue
    if (!opts.dryRun) {
      const claim = await sql`INSERT INTO auto_replies (case_id, message_id, kind, closed_reason) VALUES (${row.id}, ${row.last_message_id}, 'pending', ${spell.reason})
                              ON CONFLICT (message_id) DO NOTHING RETURNING id`
      if (!claim.length) continue
    }
    const record = async (o: AutoReplyOutcome, extra: { draftId?: number | null; sendAfter?: Date | null; deadline?: Date | null } = {}) => {
      outcomes.push(o)
      if (!opts.dryRun) await sql`UPDATE auto_replies SET kind = ${o.kind}, detail = ${o.detail.slice(0, 1000)}, draft_id = ${extra.draftId ?? null},
                                    send_after = ${extra.sendAfter ?? null}, deadline_at = ${extra.deadline ?? null} WHERE message_id = ${row.last_message_id}`
    }
    try {
      const full = await fullReply(env, sql, t)
      if (full.routine) {
        if (opts.dryRun) { await record({ case_id: row.id, case_ref: row.case_ref, kind: 'full', detail: 'routine reply, all checks passed', text: full.result.draft }); continue }
        const id = await insertDraft(sql, row.id, { lane: full.result.lane, text: full.result.draft, notes: [full.result.staff_notes, `Sent automatically on ${spell.reason} (routine reply, all checks passed).`].filter(Boolean).join('\n'),
          check: 'PASS', findings: full.stored, needsManager: false, reason: '', urgency: full.urgency, kbRuleIds: full.kbRuleIds, promptVersion: full.promptVersion?.version ?? null, auto: 'full' })
        await sendDraft(env, sql, t.kase, id, full.result.draft, { setAwaiting: true })
        await record({ case_id: row.id, case_ref: row.case_ref, kind: 'full', detail: 'routine reply sent', text: full.result.draft }, { draftId: id })
        continue
      }
      // High stakes: the full draft always waits for staff.
      const plan = holdingPlan(new Date(row.last_message_at), now, holidays, settings.extra_closed)
      const why = full.why.join(' · ')
      if (!opts.dryRun) {
        await insertDraft(sql, row.id, { lane: full.result.lane, text: full.result.draft,
          notes: [full.result.staff_notes, `Written on ${spell.reason}, not sent: ${why}. Amazon's 48-hour reply deadline: ${fmtLondon(plan.deadline)}.${plan.needed ? ` A holding reply is scheduled for ${fmtLondon(plan.sendAt!)}.` : ''}`].filter(Boolean).join('\n'),
          check: full.findings.some((f) => f.severity === 'fail') ? 'FAIL' : 'PASS', findings: full.stored, needsManager: full.needsManager, reason: full.reasons.join('; '),
          urgency: full.urgency, kbRuleIds: full.kbRuleIds, promptVersion: full.promptVersion?.version ?? null, auto: 'held' })
      }
      if (!plan.needed) {
        await record({ case_id: row.id, case_ref: row.case_ref, kind: 'staff', detail: `${why} · staff back ${fmtLondon(plan.staffBack)}, before the 48-hour deadline ${fmtLondon(plan.deadline)}; full draft saved, nothing sent` }, { deadline: plan.deadline })
        continue
      }
      if (plan.sendAt!.getTime() > now.getTime()) {
        const o: AutoReplyOutcome = { case_id: row.id, case_ref: row.case_ref, kind: 'scheduled', detail: `holding reply scheduled for ${fmtLondon(plan.sendAt!)} (${why}), 48-hour deadline ${fmtLondon(plan.deadline)}`, send_at: plan.sendAt!.toISOString() }
        if (opts.dryRun) { const h = await holdingReply(env, t.kase, t.messages, t.events, spell.reason, spell.reopens, settings.returns_note); o.text = h.text; later.add(row.id) }
        await record(o, { sendAfter: plan.sendAt, deadline: plan.deadline })
        continue
      }
      if (!opts.dryRun) await sql`UPDATE auto_replies SET kind = 'scheduled', send_after = ${now}, deadline_at = ${plan.deadline} WHERE message_id = ${row.last_message_id}`
      outcomes.push(await sendHolding({ id: row.id, case_ref: row.case_ref, message_id: row.last_message_id }, t, why, plan.deadline))
    } catch (e: any) {
      await record({ case_id: row.id, case_ref: row.case_ref, kind: 'failed', detail: String(e?.message ?? e).slice(0, 300) })
    }
  }

  // 2. Holding replies whose time has come.
  if (!opts.dryRun) {
    const due = await sql`SELECT a.case_id, a.message_id, a.detail, a.deadline_at, c.case_ref FROM auto_replies a JOIN cases c ON c.id = a.case_id
                          WHERE a.kind = 'scheduled' AND a.send_after <= ${now} ORDER BY a.send_after ASC LIMIT ${MAX_PER_RUN}`
    for (const r of due as any[]) {
      const [lm] = await sql`SELECT id, direction FROM messages WHERE case_id = ${r.case_id} AND kind IS DISTINCT FROM 'event' ORDER BY sent_at DESC, id DESC LIMIT 1`
      if (!lm || lm.id !== r.message_id || lm.direction !== 'inbound') {
        const detail = lm?.direction === 'outbound' ? 'not sent: someone already replied' : 'not sent: the customer wrote again (that message is handled on its own)'
        await sql`UPDATE auto_replies SET kind = 'superseded', detail = ${detail} WHERE message_id = ${r.message_id} AND kind = 'scheduled'`
        outcomes.push({ case_id: r.case_id, case_ref: r.case_ref, kind: 'superseded', detail })
        continue
      }
      const claimed = await sql`UPDATE auto_replies SET kind = 'pending' WHERE message_id = ${r.message_id} AND kind = 'scheduled' RETURNING id`
      if (!claimed.length) continue
      try {
        const t = await loadThread(sql, r.case_id)
        if (!t) continue
        const why = String(r.detail || '').match(/scheduled for [^(]+\((.*)\), 48-hour/)?.[1] ?? 'needs a decision from the team'
        outcomes.push(await sendHolding({ id: r.case_id, case_ref: r.case_ref, message_id: r.message_id }, t, why, new Date(r.deadline_at ?? now)))
      } catch (e: any) {
        const detail = String(e?.message ?? e).slice(0, 300)
        await sql`UPDATE auto_replies SET kind = 'failed', detail = ${detail} WHERE message_id = ${r.message_id}`
        outcomes.push({ case_id: r.case_id, case_ref: r.case_ref, kind: 'failed', detail })
      }
    }
  }
  return { ...base, outcomes }
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
