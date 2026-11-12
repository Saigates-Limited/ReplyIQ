// Approval rules shared by the draft routes, the send route and the case screen.
//
//  • decideManager  – which drafts need a manager (moved here from routes/drafts.ts so tests can import it without Hono).
//  • "Staff can send routine replies" – a manager setting (app_settings key 'approval', default ON). When ON, an agent may approve
//    AND send any eligible draft (their own, a colleague's, or one made by the system) in one step, but only if the server confirms every condition below at the moment of sending.
//    Anything else goes through Request approval and a manager, exactly as before. When OFF every draft needs a manager.
import type { getDb } from './db'
import { serverChecks, type CaseRow, type MessageRow, type DraftMode, type ServerFinding } from './ai'

type Sql = ReturnType<typeof getDb>

/** needs_manager: the model's flag OR any Step-0 / rule trigger we can verify from the data. */
export function decideManager(result: { needs_manager: boolean; urgency: string }, kase: CaseRow, messages: MessageRow[], findings: { rule: string }[], mode: DraftMode) {
  const threadText = messages.filter((m) => m.direction === 'inbound').map((m) => m.body).join('\n').toLowerCase()
  const legal = /\b(consumer rights act|trading standards|legal action|solicitor|chargeback|a[- ]to[- ]z|a-z claim|section 75|small claims|ombudsman)\b/.test(threadText)
  const batterySafety = /\b(swollen|swelling|bulging|burning|smoke|smoking|very hot|too hot|overheat)/.test(threadText) && /\b(battery|charg|hot|burn|smoke|swell|bulg)/.test(threadText)
  const reasons: string[] = []
  if (kase.refund_issued === true) reasons.push('refund already issued')
  if (kase.a_to_z_open === true) reasons.push('A-to-Z claim open')
  if (kase.chargeback_open === true) reasons.push('chargeback open')
  if (legal) reasons.push('customer mentions legal/A-to-Z/chargeback')
  if (batterySafety) reasons.push('swollen/hot/burning battery')
  if (kase.battery_flag === true) reasons.push('battery/heat flag on order')
  if (findings.some((f) => f.rule === 'refund_over_15')) reasons.push('refund above £15')
  if (mode !== 'customer') reasons.push('statement to Amazon / Seller Central')
  if (result.needs_manager && !reasons.length) reasons.push('flagged by model')
  const needsManager = result.needs_manager || reasons.length > 0
  const urgency = batterySafety || kase.battery_flag === true ? 'high' : result.urgency
  return { needsManager, reasons, urgency }
}

// ───────── Setting ─────────
export type ApprovalSettings = { staff_can_send_routine: boolean }
export const DEFAULT_APPROVAL: ApprovalSettings = { staff_can_send_routine: true }

/** Default ON when nothing has been saved. If the settings table cannot be read at all we fail CLOSED (OFF): a read error must never widen who can send. */
export async function getApprovalSettings(sql: Sql): Promise<ApprovalSettings & { updated_at: string | null; updated_by: number | null; read_error: boolean }> {
  try {
    const [r] = await sql`SELECT value, updated_at, updated_by FROM app_settings WHERE key = 'approval'`
    const v = (r?.value ?? {}) as Partial<ApprovalSettings>
    return { staff_can_send_routine: typeof v.staff_can_send_routine === 'boolean' ? v.staff_can_send_routine : DEFAULT_APPROVAL.staff_can_send_routine, updated_at: r?.updated_at ?? null, updated_by: r?.updated_by ?? null, read_error: false }
  } catch {
    return { staff_can_send_routine: false, updated_at: null, updated_by: null, read_error: true }
  }
}
export async function saveApprovalSettings(sql: Sql, patch: Partial<ApprovalSettings>, userId: number) {
  const next = { staff_can_send_routine: patch.staff_can_send_routine === true }
  await sql`INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ('approval', ${sql.json(next as any)}, ${userId}, now())
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`
  return next
}

// Migration 0020 adds the audit columns. Without them a staff send could not be recorded, so staff sending stays OFF (fail closed).
// A positive answer is cached for the life of the isolate; a negative one only briefly so the feature switches on soon after the migration is run.
let colsOk = false
let colsCheckedAt = 0
export async function hasStaffSendCols(sql: Sql) {
  if (colsOk) return true
  if (Date.now() - colsCheckedAt < 30_000) return false
  const rows = await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'drafts' AND column_name IN ('sent_without_manager_approval','routine_check')`
  colsCheckedAt = Date.now()
  colsOk = rows.length === 2
  return colsOk
}

// ───────── Eligibility (pure) ─────────
export type RoutineInput = {
  draft: { draft_text: string; mode?: string | null; check_result?: string | null; needs_manager?: boolean | null; needs_manager_reason?: string | null }
  kase: CaseRow
  inbound: MessageRow[]
  openAtozEvents: boolean
  openChargebackEvents: boolean
}
export type Eligibility = { eligible: boolean; reasons: string[]; findings: ServerFinding[]; snapshot: Record<string, unknown> }

/** Every condition is recomputed here from the draft text and the live case: nothing is trusted from a stored flag alone. */
export function evaluateRoutine(i: RoutineInput): Eligibility {
  const mode = ((i.draft.mode as DraftMode) || 'customer') as DraftMode
  const findings = serverChecks(i.draft.draft_text, i.kase, mode)
  const reasons: string[] = []
  const add = (r: string) => { if (!reasons.includes(r)) reasons.push(r) }

  if (mode !== 'customer') add('Seller Central / Amazon statements always need a manager')
  // 1. guardrail result is PASS with no warnings (fresh run AND the stored result)
  for (const f of findings) add(f.severity === 'fail' ? `Guardrail check fails: ${f.detail}` : `Guardrail warning: ${f.detail}`)
  if (i.draft.check_result !== 'PASS') add('The saved guardrail result is not PASS')
  // 2. needs_manager is false (stored flag AND a fresh recompute from the live case + thread)
  if (i.draft.needs_manager === true) add(`Marked needs-manager${i.draft.needs_manager_reason ? ` (${i.draft.needs_manager_reason})` : ''}`)
  const decided = decideManager({ needs_manager: false, urgency: 'normal' }, i.kase, i.inbound, findings, mode)
  const covered = new Set(['A-to-Z claim open', 'chargeback open', 'battery/heat flag on order'])
  if (decided.needsManager) for (const r of decided.reasons) if (!covered.has(r) && !(mode !== 'customer' && r === 'statement to Amazon / Seller Central')) add(`Needs a manager: ${r}`)
  // 3. no open A-to-Z, no open chargeback, no battery_flag (case flags AND the open Amazon notices)
  if (i.kase.a_to_z_open === true) add('A-to-Z claim open on this case')
  if (i.openAtozEvents) add('An A-to-Z claim from Amazon is still open on this order')
  if (i.kase.chargeback_open === true) add('Chargeback open on this case')
  if (i.openChargebackEvents) add('A chargeback from Amazon is still open on this order')
  if (i.kase.battery_flag === true) add('Battery / heat flag on this order')

  return {
    eligible: reasons.length === 0, reasons, findings,
    snapshot: {
      checked_at: new Date().toISOString(), guardrail: i.draft.check_result ?? null, findings: findings.length,
      needs_manager: false, a_to_z_open: i.kase.a_to_z_open === true, chargeback_open: i.kase.chargeback_open === true, battery_flag: i.kase.battery_flag === true,
      open_atoz_events: i.openAtozEvents, open_chargeback_events: i.openChargebackEvents, rule: 'staff_routine_reply',
    },
  }
}

/** Loads the live case, thread and open Amazon notices, then evaluates. */
export async function routineEligibility(sql: Sql, d: { case_id: number } & RoutineInput['draft']): Promise<Eligibility> {
  const [kase] = await sql<CaseRow[]>`SELECT * FROM cases WHERE id = ${d.case_id}`
  if (!kase) return { eligible: false, reasons: ['Case not found'], findings: [], snapshot: {} }
  const inbound = await sql<MessageRow[]>`SELECT direction, body, sent_at, sender, kind FROM messages WHERE case_id = ${d.case_id} AND direction = 'inbound'`
  // Same "open" meaning as the inbox badges (EVENT_FLAGS): anything not won / lost / closed. A NULL status counts as open here.
  const [ev] = await sql`SELECT
      EXISTS (SELECT 1 FROM amazon_events e WHERE e.case_id = ${d.case_id} AND e.kind LIKE 'atoz%' AND COALESCE(e.status, 'open') NOT IN ('won','lost','closed')) AS atoz,
      EXISTS (SELECT 1 FROM amazon_events e WHERE e.case_id = ${d.case_id} AND e.kind = 'chargeback' AND COALESCE(e.status, 'open') NOT IN ('won','lost','closed')) AS chargeback`
  return evaluateRoutine({ draft: d, kase, inbound, openAtozEvents: !!ev?.atoz, openChargebackEvents: !!ev?.chargeback })
}

// ───────── The gate used by POST /drafts/:id/send (and the case screen's button hint) ─────────
export type Verdict = { ok: boolean; enabled: boolean; error: string; reasons: string[]; check?: Record<string, unknown> }
const ASK = 'Press "Request approval" and a manager will review it.'

/** May this signed-in user send this un-approved draft on their own authority? Any active agent may send any eligible draft; the sender is recorded (sent_recorded_by). Role and active flag are read from the users table, not the session. */
export async function staffRoutineVerdict(sql: Sql, user: { id: number }, d: any): Promise<Verdict> {
  const [u] = await sql`SELECT role, is_active FROM users WHERE id = ${user.id}`
  if (!u || u.is_active === false) return { ok: false, enabled: false, error: 'Your account is not active.', reasons: ['Account not active'] }
  if (u.role === 'manager') return { ok: false, enabled: false, error: 'Approve the reply first, then send it.', reasons: [] }
  const s = await getApprovalSettings(sql)
  if (!s.staff_can_send_routine) return { ok: false, enabled: false, error: `This reply has not been approved. ${ASK}`, reasons: ['Staff sending of routine replies is switched off — every reply needs a manager'] }
  if (!(await hasStaffSendCols(sql)))
    return { ok: false, enabled: true, error: `Direct sending is paused until database migration 0020 has been run (it records who sent without a manager). ${ASK}`, reasons: ['Migration 0020 has not been run'] }
  const e = await routineEligibility(sql, d)
  if (!e.eligible) return { ok: false, enabled: true, error: `This reply needs a manager's approval: ${e.reasons.join('; ')}. ${ASK}`, reasons: e.reasons }
  return { ok: true, enabled: true, error: '', reasons: [], check: e.snapshot }
}

/** Test hook: forget the cached "migration 0020 is applied" answer. */
export function _resetStaffColsCache() { colsOk = false; colsCheckedAt = 0 }
