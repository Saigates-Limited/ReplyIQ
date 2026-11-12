import { Hono } from 'hono'
import { getDb, type Bindings } from '../db'
import { requireManager, type Vars } from '../auth'
import { generateDraft, serverChecks, MODEL, DRAFT_MODES, type CaseRow, type MessageRow, type EventRow, type DraftMode } from '../ai'
import { loadActiveRules } from '../kb'
import { loadCurrentPrompt } from '../systemPrompt'
import { decideManager, getApprovalSettings, saveApprovalSettings, hasStaffSendCols, staffRoutineVerdict } from '../approval'

export const draftsApi = new Hono<{ Bindings: Bindings; Variables: Vars }>()

const DRAFT_SELECT = `
  d.*, 
  cu.name AS created_by_name, eu.name AS edited_by_name, au.name AS approved_by_name, su.name AS sent_recorded_by_name
`
const DRAFT_JOINS = `
  LEFT JOIN users cu ON cu.id = d.created_by
  LEFT JOIN users eu ON eu.id = d.edited_by
  LEFT JOIN users au ON au.id = d.approved_by
  LEFT JOIN users su ON su.id = d.sent_recorded_by
`

export { decideManager }

async function loadDraft(sql: ReturnType<typeof getDb>, id: number) {
  const hasReq = (await draftCols(sql)).has('approval_requested_by')
  const extra = hasReq ? ', ru.name AS approval_requested_by_name, rj.name AS rejected_by_name' : ''
  const joins = hasReq ? `${DRAFT_JOINS} LEFT JOIN users ru ON ru.id = d.approval_requested_by LEFT JOIN users rj ON rj.id = d.rejected_by` : DRAFT_JOINS
  const [d] = await sql.unsafe(`SELECT ${DRAFT_SELECT}${extra} FROM drafts d ${joins} WHERE d.id = $1`, [id])
  return d
}

type Sql = ReturnType<typeof getDb>

// Optional drafts columns, detected once per isolate (an information_schema query on every draft is CPU we do not have on the Free plan).
let draftColsCache: Set<string> | null = null
async function draftCols(sql: Sql) {
  if (!draftColsCache) {
    const rows = await sql<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_name = 'drafts' AND column_name IN ('kb_rule_ids','system_prompt_version','revision_of','approval_requested_by','rejection_reason','agent_guidance')`
    draftColsCache = new Set(rows.map((r) => r.column_name))
  }
  return draftColsCache
}

/** Generate + store one draft for a case. Shared by "Generate draft" and "Request changes" (revision). */
async function createDraft(env: Bindings, sql: Sql, caseId: number, userId: number, mode: DraftMode,
  revision?: { previousDraft: string; guidance: string; previousDraftId: number } | null) {
  const [kase] = await sql<CaseRow[]>`SELECT * FROM cases WHERE id = ${caseId}`
  if (!kase) return { error: 'Case not found', status: 404 as const }
  // Refund-email timeline entries (sender 'Amazon Refund', linked to a refund_initiated event) never reach the model (privacy rule, Phase 15).
  const messages = await sql<MessageRow[]>`SELECT m.direction, m.body, m.sent_at, m.sender, m.kind, m.id FROM messages m
    WHERE m.case_id = ${caseId} AND NOT EXISTS (SELECT 1 FROM amazon_events e WHERE e.id = m.event_id AND e.kind = 'refund_initiated') AND m.sender IS DISTINCT FROM 'Amazon Refund'
    ORDER BY m.sent_at ASC`
  // Attachment METADATA only (filename/type/size) so the model knows photos exist; bytes never leave Gmail/R2.
  const atts = await sql<{ message_id: number; filename: string; mime_type: string; size_bytes: number }[]>`SELECT message_id, filename, mime_type, size_bytes FROM attachments WHERE case_id = ${caseId}`.catch(() => [] as any[])
  for (const m of messages as any[]) m.attachments = atts.filter((a) => a.message_id === m.id)
  const events = await sql<EventRow[]>`
    SELECT kind, status, amount, currency, received_at, deadline_at, return_reason, customer_comment, authorisation, policy_check, item_description
    FROM amazon_events WHERE case_id = ${caseId} AND kind <> 'refund_initiated' ORDER BY received_at ASC  -- refund emails never reach the model (privacy rule, Phase 15)`
  if (!messages.length && !events.length) return { error: 'Case has no messages to reply to', status: 400 as const }
  if (mode === 'customer' && !messages.some((m) => m.direction === 'inbound' && m.kind !== 'event'))
    return { error: 'No customer message on this case to reply to. Use a Seller Central mode instead.', status: 400 as const }

  const kbRules = await loadActiveRules(sql, mode)
  const promptVersion = await loadCurrentPrompt(sql)
  const { result, payload, kbRuleIds } = await generateDraft(env, kase, messages, { events, mode, kbRules, customPrompt: promptVersion?.body, revision })
  const findings = serverChecks(result.draft, kase, mode)
  const checkResult = findings.some((f) => f.severity === 'fail') ? 'FAIL' : 'PASS'
  const { needsManager, reasons, urgency } = decideManager(result, kase, messages, findings, mode)

  // Optional audit columns arrive with migrations 0011 (kb_rule_ids), 0012 (system_prompt_version) and 0016 (revision_of, agent_guidance).
  // Detect once per request and omit whichever is missing so drafting keeps working before they are applied.
  const cols = await draftCols(sql)
  const has = (n: string) => cols.has(n)
  const hasKb = has('kb_rule_ids'), hasSpv = has('system_prompt_version'), hasRev = has('revision_of') && has('agent_guidance')
  const [d] = await sql`
    INSERT INTO drafts (case_id, tree, draft_text, original_text, staff_notes, check_result, check_findings, server_findings,
                        needs_manager, needs_manager_reason, urgency, model, created_by, mode
                        ${hasKb ? sql`, kb_rule_ids` : sql``} ${hasSpv ? sql`, system_prompt_version` : sql``} ${hasRev ? sql`, revision_of, agent_guidance` : sql``})
    VALUES (${caseId}, ${result.lane}, ${result.draft}, ${result.draft}, ${result.staff_notes}, ${checkResult},
            ${sql.json([])}, ${sql.json(findings)},
            ${needsManager}, ${reasons.join('; ')}, ${urgency}, ${MODEL}, ${userId}, ${mode}
            ${hasKb ? sql`, string_to_array(${kbRuleIds.join(',')}, ',')::int[]` : sql``} ${hasSpv ? sql`, ${promptVersion?.version ?? null}` : sql``}
            ${hasRev ? sql`, ${revision?.previousDraftId ?? null}, ${revision?.guidance ?? null}` : sql``})
    RETURNING id`
  const draft = await loadDraft(sql, d.id)
  return { draft, payload, kbRules, promptVersion }
}

// POST /api/cases/:id/drafts  → generate a new draft with OpenAI (server-side only)
draftsApi.post('/cases/:id/drafts', async (c) => {
  const caseId = Number(c.req.param('id'))
  if (!Number.isInteger(caseId)) return c.json({ error: 'Invalid id' }, 400)
  const user = c.get('user')
  const body = (await c.req.json().catch(() => ({}))) as { mode?: string }
  const mode: DraftMode = DRAFT_MODES.includes(body.mode as DraftMode) ? (body.mode as DraftMode) : 'customer'
  const sql = getDb(c.env)
  try {
    const r = await createDraft(c.env, sql, caseId, user.id, mode)
    if ('error' in r) return c.json({ error: r.error }, r.status)
    // Return what was sent to the model so the agent can see exactly what left the server.
    return c.json({ draft: r.draft, sent_to_model: r.payload, kb_rules_applied: r.kbRules.map((x) => ({ id: x.id, title: x.title })), system_prompt_version: r.promptVersion?.version ?? null }, 201)
  } finally {
    await sql.end()
  }
})

// POST /api/drafts/:id/revise {guidance} → the agent says what to change; the model rewrites; the old draft is superseded.
// Guidance is an instruction to the model, never pasted into the reply, and the policy still overrides it.
draftsApi.post('/drafts/:id/revise', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'Invalid id' }, 400)
  const user = c.get('user')
  const body = (await c.req.json().catch(() => ({}))) as { guidance?: string; draft_text?: string }
  const guidance = String(body.guidance ?? '').trim()
  if (guidance.length < 3) return c.json({ error: 'Say what you want changed (a sentence or two is enough).' }, 400)
  if (guidance.length > 2000) return c.json({ error: 'Keep the change request under 2,000 characters.' }, 400)
  // Guardrails on the instruction itself: the agent can ask for tone, length, wording or facts to be fixed, but not for
  // the model to skip policy. Anything matching these is refused before OpenAI is called (the policy still overrides the rest).
  const g = guidance.toLowerCase()
  const blocked: [RegExp, string][] = [
    [/\b(ignore|skip|bypass|override|forget|disregard)\b[^.]{0,40}\b(polic(y|ies)|rules?|checks?|guidelines?|instructions?)\b/, 'asks the model to ignore the policy'],
    [/\b(refund|credit|compensat\w*|goodwill|discount)\b[^.]{0,30}£\s?(1[6-9]|[2-9]\d|\d{3,})/, 'offers more than £15 — a manager must approve refunds above £15'],
    // Only when the agent asks the model to OFFER/PROMISE one. Describing a refund already issued ("the full refund has been processed") is fine.
    [/\b(offer|give|promise|provide|issue|send|grant|agree to|tell them (they('ll| will) get|we('ll| will) give))\b[^.]{0,25}\b(a |the )?full refund\b(?![^.]{0,30}\b(already|has been|was|were|had been|is on its way|processed|issued|sent)\b)/, 'promises a full refund — only a manager can authorise that'],
    [/\brefund (them|the customer|him|her) in full\b|\brefund everything\b/, 'promises a full refund — only a manager can authorise that'],
    [/\b(don'?t|do not|never) (mention|say|tell)[^.]{0,30}\b(warranty|amazon|return|policy)\b/, 'hides policy information from the customer'],
    [/\b(send|email|forward)\b[^.]{0,30}\b(amazon|seller central|a-?to-?z)\b/, 'asks for an Amazon-side statement — use a Seller Central mode instead'],
    [/\b(include|add|put|write)\b[^.]{0,30}\b(serial|tracking number of the return|internal note|staff note)\b/, 'would put internal data in a customer email'],
  ]
  const hit = blocked.find(([re]) => re.test(g))
  if (hit) return c.json({ error: `Change request refused: it ${hit[1]}. Reword it, or ask a manager.` }, 422)
  const sql = getDb(c.env)
  try {
    const prev = await loadDraft(sql, id)
    if (!prev) return c.json({ error: 'Draft not found' }, 404)
    if (!['draft', 'approved', 'pending_approval'].includes(prev.status)) return c.json({ error: `Draft is ${prev.status}; generate a new one instead.` }, 409)
    // If the agent typed edits in the box before asking, revise from what is on screen.
    const previousDraft = typeof body.draft_text === 'string' && body.draft_text.trim() ? body.draft_text.slice(0, 20000) : prev.draft_text
    const r = await createDraft(c.env, sql, prev.case_id, user.id, prev.mode ?? 'customer', { previousDraft, guidance, previousDraftId: id })
    if ('error' in r) return c.json({ error: r.error }, r.status)
    await sql`UPDATE drafts SET status = 'discarded', updated_at = now() WHERE id = ${id} AND status IN ('draft','approved','pending_approval')`
    // The rewrite went through exactly the same server checks + manager rules as a fresh draft (createDraft). It always starts as
    // 'draft': it never inherits an approval or a pending request from the version it replaces. Report the outcome plainly.
    const nd: any = r.draft
    const fnd = (nd.server_findings ?? []) as { severity: string; detail: string }[]
    const fails = fnd.filter((f) => f.severity === 'fail'), warns = fnd.filter((f) => f.severity === 'warn')
    const approvalCleared = prev.status === 'approved' || prev.status === 'pending_approval'
    const notes: string[] = []
    if (fails.length) notes.push(`The rewrite FAILS the server checks (${fails.map((f) => f.detail).join('; ')}) — fix it before sending.`)
    if (warns.length) notes.push(`Guardrail warning${warns.length > 1 ? 's' : ''}: ${warns.map((f) => f.detail).join('; ')}.`)
    if (nd.needs_manager) notes.push(`The rewrite needs a manager's approval (${nd.needs_manager_reason || 'policy rule'}).`)
    if (approvalCleared) notes.push(prev.status === 'approved' ? 'The earlier approval does not carry over — the rewrite needs approval again.' : 'The earlier approval request was cancelled — request approval again for the rewrite.')
    const check = { result: nd.check_result, warnings: warns.length, needs_manager: !!nd.needs_manager, needs_manager_reason: nd.needs_manager_reason || null, approval_cleared: approvalCleared, clean: !fails.length && !warns.length && !nd.needs_manager }
    const warn = notes.length ? notes.join(' ') : null
    return c.json({ draft: r.draft, superseded: id, guardrail: warn, check }, 201)
  } finally {
    await sql.end()
  }
})

// PATCH /api/drafts/:id  → edit text / staff notes (re-runs server checks)
draftsApi.patch('/drafts/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = (await c.req.json().catch(() => ({}))) as { draft_text?: string; staff_notes?: string }
  const user = c.get('user')
  const sql = getDb(c.env)
  try {
    const existing = await loadDraft(sql, id)
    if (!existing) return c.json({ error: 'Draft not found' }, 404)
    if (existing.status === 'sent') return c.json({ error: 'Draft already recorded as sent' }, 409)

    const text = typeof body.draft_text === 'string' ? body.draft_text.trim() : existing.draft_text
    if (!text) return c.json({ error: 'Draft text cannot be empty' }, 400)
    const notes = typeof body.staff_notes === 'string' ? body.staff_notes : existing.staff_notes
    const [kase] = await sql<CaseRow[]>`SELECT * FROM cases WHERE id = ${existing.case_id}`
    const findings = serverChecks(text, kase, (existing.mode as DraftMode) || 'customer')
    const serverFail = findings.some((f) => f.severity === 'fail')
    // Editing an approved draft un-approves it — approval must be re-given on the final text.
    await sql`
      UPDATE drafts SET draft_text = ${text}, staff_notes = ${notes}, server_findings = ${sql.json(findings)},
        check_result = ${serverFail ? 'FAIL' : 'PASS'},
        status = CASE WHEN status = 'approved' THEN 'draft' ELSE status END,
        approved_by = CASE WHEN status = 'approved' THEN NULL ELSE approved_by END,
        approved_at = CASE WHEN status = 'approved' THEN NULL ELSE approved_at END,
        edited_by = ${user.id}, edited_at = now(), updated_at = now()
      WHERE id = ${id}`
    return c.json({ draft: await loadDraft(sql, id) })
  } finally {
    await sql.end()
  }
})

// ───────── Setting: "Staff can send routine replies" (manager-controlled, default ON) ─────────
// GET: everyone signed in (the Settings page and the draft panel need to show it). PUT: managers only.
draftsApi.get('/approval-settings', async (c) => {
  const sql = getDb(c.env)
  try {
    const s = await getApprovalSettings(sql)
    const migrated = await hasStaffSendCols(sql).catch(() => false)
    const [u] = s.updated_by ? await sql`SELECT name FROM users WHERE id = ${s.updated_by}`.catch(() => [] as any[]) : []
    return c.json({ staff_can_send_routine: s.staff_can_send_routine, effective: s.staff_can_send_routine && migrated, migration_ok: migrated, updated_at: s.updated_at, updated_by_name: u?.name ?? null })
  } finally { await sql.end() }
})
draftsApi.put('/approval-settings', requireManager, async (c) => {
  const user = c.get('user')
  const body = (await c.req.json().catch(() => ({}))) as { staff_can_send_routine?: unknown }
  if (typeof body.staff_can_send_routine !== 'boolean') return c.json({ error: 'staff_can_send_routine must be true or false' }, 400)
  const sql = getDb(c.env)
  try {
    const next = await saveApprovalSettings(sql, { staff_can_send_routine: body.staff_can_send_routine }, user.id)
    const migrated = await hasStaffSendCols(sql).catch(() => false)
    return c.json({ staff_can_send_routine: next.staff_can_send_routine, effective: next.staff_can_send_routine && migrated, migration_ok: migrated })
  } finally { await sql.end() }
})

// GET /api/drafts/:id/routine-check — can the signed-in user send THIS draft without a manager, right now? (UI hint only; /send re-checks.)
draftsApi.get('/drafts/:id/routine-check', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'Invalid id' }, 400)
  const user = c.get('user')
  const sql = getDb(c.env)
  try {
    const d = await loadDraft(sql, id)
    if (!d) return c.json({ error: 'Draft not found' }, 404)
    if (user.role === 'manager' || d.status !== 'draft') return c.json({ applies: false, eligible: false, reasons: [] })
    const v = await staffRoutineVerdict(sql, user, d)
    return c.json({ applies: true, eligible: v.ok, setting_on: v.enabled, reasons: v.reasons })
  } finally { await sql.end() }
})

// ───────── Approval flow ─────────
// draft ──(anyone: Request approval)──▶ pending_approval ──(manager: Approve)──▶ approved ──▶ sent
//                                       └──(manager: Reject, with reason)──▶ draft
// A manager may also approve a plain draft directly. Approval is an explicit manager action, with ONE exception: when Settings →
// "Staff can send routine replies" is ON, any active agent may send an eligible draft (own, a colleague's or system-made) without a manager if the server re-verifies at send time
// that it is routine (approval.ts: PASS with no warnings, needs_manager false, no open A-to-Z / chargeback, no battery_flag).
// That path is audited (sent_without_manager_approval). Editing after approval drops the draft back to 'draft'.

// POST /api/drafts/:id/request-approval {note?} — agent (or anyone) asks a manager to approve this text
draftsApi.post('/drafts/:id/request-approval', async (c) => {
  const id = Number(c.req.param('id'))
  const user = c.get('user')
  const body = (await c.req.json().catch(() => ({}))) as { note?: string }
  const sql = getDb(c.env)
  try {
    const d = await loadDraft(sql, id)
    if (!d) return c.json({ error: 'Draft not found' }, 404)
    if (d.status === 'pending_approval') return c.json({ error: 'Approval has already been requested for this draft' }, 409)
    if (d.status !== 'draft') return c.json({ error: `Draft is ${d.status}` }, 409)
    if ((d.server_findings ?? []).some((f: any) => f.severity === 'fail')) return c.json({ error: 'Fix the failing checks before requesting approval' }, 422)
    const hasReq = (await draftCols(sql)).has('approval_requested_by')
    if (hasReq) await sql`UPDATE drafts SET status = 'pending_approval', approval_requested_by = ${user.id}, approval_requested_at = now(), approval_note = ${String(body.note ?? '').slice(0, 1000) || null}, rejected_by = NULL, rejected_at = NULL, rejection_reason = NULL, updated_at = now() WHERE id = ${id}`
    else await sql`UPDATE drafts SET status = 'pending_approval', updated_at = now() WHERE id = ${id}`
    return c.json({ draft: await loadDraft(sql, id) })
  } finally { await sql.end() }
})

// POST /api/drafts/:id/withdraw-request — the requester (or a manager) takes the request back
draftsApi.post('/drafts/:id/withdraw-request', async (c) => {
  const id = Number(c.req.param('id'))
  const user = c.get('user')
  const sql = getDb(c.env)
  try {
    const d = await loadDraft(sql, id)
    if (!d) return c.json({ error: 'Draft not found' }, 404)
    if (d.status !== 'pending_approval') return c.json({ error: 'No approval request is open on this draft' }, 409)
    if (user.role !== 'manager' && d.approval_requested_by != null && d.approval_requested_by !== user.id) return c.json({ error: 'Only the person who asked, or a manager, can withdraw the request' }, 403)
    await sql`UPDATE drafts SET status = 'draft', updated_at = now() WHERE id = ${id}`
    return c.json({ draft: await loadDraft(sql, id) })
  } finally { await sql.end() }
})

// POST /api/drafts/:id/approve — MANAGER ONLY, from draft or pending_approval. Approves the exact text on record.
draftsApi.post('/drafts/:id/approve', requireManager, async (c) => {
  const id = Number(c.req.param('id'))
  const user = c.get('user')
  const sql = getDb(c.env)
  try {
    const d = await loadDraft(sql, id)
    if (!d) return c.json({ error: 'Draft not found' }, 404)
    if (!['draft', 'pending_approval'].includes(d.status)) return c.json({ error: `Draft is already ${d.status}` }, 409)
    const serverFail = (d.server_findings ?? []).some((f: any) => f.severity === 'fail')
    if (serverFail) return c.json({ error: 'Fix the failing checks before approving' }, 422)
    await sql`UPDATE drafts SET status = 'approved', approved_by = ${user.id}, approved_at = now(), updated_at = now() WHERE id = ${id}`
    return c.json({ draft: await loadDraft(sql, id) })
  } finally {
    await sql.end()
  }
})

// POST /api/drafts/:id/reject {reason} — MANAGER ONLY: send it back to the agent with a reason
draftsApi.post('/drafts/:id/reject', requireManager, async (c) => {
  const id = Number(c.req.param('id'))
  const user = c.get('user')
  const body = (await c.req.json().catch(() => ({}))) as { reason?: string }
  const reason = String(body.reason ?? '').trim()
  if (reason.length < 3) return c.json({ error: 'Give the agent a reason (a few words is enough)' }, 400)
  const sql = getDb(c.env)
  try {
    const d = await loadDraft(sql, id)
    if (!d) return c.json({ error: 'Draft not found' }, 404)
    if (!['pending_approval', 'approved'].includes(d.status)) return c.json({ error: `Draft is ${d.status}; nothing to reject` }, 409)
    const hasReq = (await draftCols(sql)).has('rejection_reason')
    if (hasReq) await sql`UPDATE drafts SET status = 'draft', approved_by = NULL, approved_at = NULL, rejected_by = ${user.id}, rejected_at = now(), rejection_reason = ${reason.slice(0, 1000)}, updated_at = now() WHERE id = ${id}`
    else await sql`UPDATE drafts SET status = 'draft', approved_by = NULL, approved_at = NULL, staff_notes = ${`[Rejected by ${user.name}: ${reason.slice(0, 500)}] `} || COALESCE(staff_notes, ''), updated_at = now() WHERE id = ${id}`
    return c.json({ draft: await loadDraft(sql, id) })
  } finally { await sql.end() }
})

// GET /api/drafts/pending — approval requests. Managers: everything waiting. Agents: their own requests (so they can see progress).
draftsApi.get('/drafts/pending', async (c) => {
  const user = c.get('user')
  const sql = getDb(c.env)
  try {
    const hasReq = (await draftCols(sql)).has('approval_requested_by')
    const mine = user.role !== 'manager'
    const rows = await sql.unsafe(`
      SELECT d.id, d.case_id, d.status, d.draft_text, d.tree, d.mode, d.needs_manager, d.needs_manager_reason, d.urgency, d.check_result, d.created_at, d.updated_at,
             ${hasReq ? 'd.approval_requested_at, d.approval_note, ru.name AS approval_requested_by_name, d.approval_requested_by,' : 'd.updated_at AS approval_requested_at, NULL::text AS approval_note, cu.name AS approval_requested_by_name, d.created_by AS approval_requested_by,'}
             k.case_ref, k.subject, k.order_id, k.customer_first_name, k.tone, k.battery_flag, cu.name AS created_by_name
      FROM drafts d JOIN cases k ON k.id = d.case_id
      LEFT JOIN users cu ON cu.id = d.created_by ${hasReq ? 'LEFT JOIN users ru ON ru.id = d.approval_requested_by' : ''}
      WHERE d.status = 'pending_approval' AND k.archived_at IS NULL ${mine ? `AND (${hasReq ? 'd.approval_requested_by' : 'd.created_by'} = $1 OR d.created_by = $1)` : ''}
      ORDER BY (d.urgency = 'high') DESC, ${hasReq ? 'd.approval_requested_at' : 'd.updated_at'} ASC LIMIT 100`, mine ? [user.id] : [])
    return c.json({ pending: rows, manager: !mine })
  } finally { await sql.end() }
})

// POST /api/drafts/:id/unapprove  (manager, or the approver)
draftsApi.post('/drafts/:id/unapprove', async (c) => {
  const id = Number(c.req.param('id'))
  const user = c.get('user')
  const sql = getDb(c.env)
  try {
    const d = await loadDraft(sql, id)
    if (!d) return c.json({ error: 'Draft not found' }, 404)
    if (d.status !== 'approved') return c.json({ error: 'Draft is not approved' }, 409)
    if (user.role !== 'manager' && d.approved_by !== user.id) return c.json({ error: 'Only the approver or a manager can withdraw approval' }, 403)
    await sql`UPDATE drafts SET status = 'draft', approved_by = NULL, approved_at = NULL, updated_at = now() WHERE id = ${id}`
    return c.json({ draft: await loadDraft(sql, id) })
  } finally {
    await sql.end()
  }
})

// POST /api/drafts/:id/record-sent → agent confirms they sent the approved text manually via Amazon.
// This app never sends anything itself; this only logs the outbound message on the thread.
draftsApi.post('/drafts/:id/record-sent', async (c) => {
  const id = Number(c.req.param('id'))
  const user = c.get('user')
  const sql = getDb(c.env)
  try {
    const d = await loadDraft(sql, id)
    if (!d) return c.json({ error: 'Draft not found' }, 404)
    // Same two routes as /send: a manager-approved draft, or (setting ON) any active agent sending an eligible routine draft, re-verified now.
    let routine: Record<string, unknown> | null = null
    if (d.status === 'draft') {
      const v = await staffRoutineVerdict(sql, user, d)
      if (!v.ok) return c.json({ error: v.error.replace(/^This reply has not been approved\. /, 'This reply has not been approved, so it cannot be recorded as sent. '), reasons: v.reasons }, 403)
      routine = v.check ?? {}
    } else if (d.status !== 'approved') return c.json({ error: 'Only approved drafts can be recorded as sent' }, 409)
    const toAmazon = d.mode && d.mode !== 'customer'
    await sql.begin(async (tx) => {
      const upd = await tx`UPDATE drafts SET status = 'sent', sent_recorded_by = ${user.id}, sent_recorded_at = now(), updated_at = now() WHERE id = ${id} AND status = ${d.status} AND draft_text = ${d.draft_text} RETURNING id`
      if (!upd.length) throw new Error('The draft changed while it was being recorded — reload and try again')
      if (routine) await tx`UPDATE drafts SET sent_without_manager_approval = TRUE, routine_check = ${tx.json(routine as any)} WHERE id = ${id}`
      await tx`INSERT INTO messages (case_id, direction, sender, body, kind) VALUES (${d.case_id}, 'outbound', ${(toAmazon ? 'Saigates → Amazon/Seller Central (' : 'Saigates Support (') + user.name + ')'}, ${d.draft_text}, ${toAmazon ? 'seller_central_copy' : 'message'})`
      if (toAmazon) {
        // Mark the matching open Amazon event as responded
        const evKind = d.mode === 'seller_central_atoz' ? ['atoz_claim', 'atoz_info_request'] : d.mode === 'chargeback_evidence' ? ['chargeback'] : ['return_request']
        await tx`UPDATE amazon_events SET status = CASE WHEN kind = 'return_request' THEN status ELSE 'response_sent' END,
                   response_text = ${d.draft_text}, responded_by = ${user.id}, responded_at = now(), updated_at = now()
                 WHERE case_id = ${d.case_id} AND kind = ANY(string_to_array(${evKind.join(',')}, ',')) AND status IN ('open','requested','info_requested')`
      }
      await tx`UPDATE cases SET status = 'awaiting_customer', updated_at = now() WHERE id = ${d.case_id} AND status = 'open'`
    })
    if (!toAmazon) await sql`UPDATE carrier_cases SET customer_update_due = FALSE WHERE case_id = ${d.case_id} AND customer_update_due`.catch(() => {})
    return c.json({ draft: await loadDraft(sql, id) })
  } finally {
    await sql.end()
  }
})

// POST /api/drafts/:id/discard
draftsApi.post('/drafts/:id/discard', async (c) => {
  const id = Number(c.req.param('id'))
  const sql = getDb(c.env)
  try {
    const d = await loadDraft(sql, id)
    if (!d) return c.json({ error: 'Draft not found' }, 404)
    if (d.status === 'sent') return c.json({ error: 'Cannot discard a sent draft' }, 409)
    await sql`UPDATE drafts SET status = 'discarded', updated_at = now() WHERE id = ${id}`
    return c.json({ draft: await loadDraft(sql, id) })
  } finally {
    await sql.end()
  }
})
