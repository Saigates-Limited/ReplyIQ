// Carrier desk API: investigations and claims with Royal Mail, DPD, FedEx and Evri.
// Email to a carrier leaves ONLY through POST /api/carrier/drafts/:id/send, after a person approves the exact text.
import { Hono } from 'hono'
import { getDb, type Bindings } from '../db'
import { requireManager, type Vars } from '../auth'
import { accessToken, listConnections, sendEmail, messageIdHeader } from '../gmail'
import { CARRIERS, normaliseCarrier, normaliseTracking, carrierOfTracking, type CarrierId } from '../carrier/carriers'
import { onOutbound, onClaimSubmitted, CLOSED_STATUSES, ON_US_STATUSES, WAITING_STATUSES, STATUS_LABEL, type CarrierStatus } from '../carrier/engine'
import { ISSUE_LABEL, detectCarrierIssue } from '../carrier/detect'
import { inboundLabel } from '../carrier/classify'
import type { DraftKind } from '../carrier/templates'
import { BANK_HOLIDAYS_UNTIL } from '../carrier/workdays'
import {
  getSettings, saveSettings, carrierAddress, recipientAllowed, loadCarrierCase, prepareDraft, openInvestigation, applyPatch,
  decorate, syncCarrierMail, prepareDueDrafts, isIssue, DEFAULT_SETTINGS, type CarrierSettings,
} from '../carrier/service'

export const carrierApi = new Hono<{ Bindings: Bindings; Variables: Vars }>()

const LIST_SQL = `
  SELECT cc.*, c.case_ref, c.customer_first_name, c.subject AS case_subject,
    COALESCE((SELECT json_agg(json_build_object('id', d.id, 'kind', d.kind, 'status', d.status, 'auto', d.auto_created, 'needs_manager', d.needs_manager) ORDER BY d.id)
              FROM carrier_drafts d WHERE d.carrier_case_id = cc.id AND d.status IN ('draft','approved')), '[]') AS live_drafts,
    (SELECT m.summary FROM carrier_messages m WHERE m.carrier_case_id = cc.id ORDER BY m.sent_at DESC LIMIT 1) AS last_event
  FROM carrier_cases cc LEFT JOIN cases c ON c.id = cc.case_id`

const tableMissing = (e: any) => /relation "carrier_|relation "app_settings/.test(String(e?.message))
const needMigration = (c: any) => c.json({ error: 'Run db/migrations/0015_carrier_desk.sql in Supabase first.' }, 503)

// GET /api/carrier/cases?view=open|chase|on_us|waiting|closed|all
carrierApi.get('/cases', async (c) => {
  const view = c.req.query('view') ?? 'open'
  const sql = getDb(c.env)
  try {
    const rows = (await sql.unsafe(`${LIST_SQL} ORDER BY cc.updated_at DESC LIMIT 2000`)).map((k: any) => decorate(k))
    const isOpen = (k: any) => !CLOSED_STATUSES.includes(k.status)
    const filtered = rows.filter((k: any) =>
      view === 'all' ? true
      : view === 'closed' ? !isOpen(k)
      : view === 'chase' ? k.display_status === 'sla_breach'
      : view === 'on_us' ? ON_US_STATUSES.includes(k.status) || k.customer_update_due
      : view === 'waiting' ? isOpen(k) && k.display_status !== 'sla_breach' && !ON_US_STATUSES.includes(k.status)
      : isOpen(k))
    // Most urgent first: carrier overdue (longest wait), then things on us, then by next due date
    const rank = (k: any) => (k.display_status === 'sla_breach' ? 0 : ON_US_STATUSES.includes(k.status) ? 1 : isOpen(k) ? 2 : 3)
    filtered.sort((a: any, b: any) => rank(a) - rank(b) || (b.waiting_working_days ?? -1) - (a.waiting_working_days ?? -1) || String(a.next_due ?? '9').localeCompare(String(b.next_due ?? '9')))
    return c.json({ cases: filtered, now: new Date().toISOString(), status_labels: STATUS_LABEL, issue_labels: ISSUE_LABEL })
  } catch (e) { if (tableMissing(e)) return needMigration(c); throw e } finally { await sql.end() }
})

// GET /api/carrier/summary → KPI tiles (dashboard + carrier desk)
// Summary is fetched on every page load and every badge refresh, so it is a single aggregate query:
// loading + decorating every carrier case here pushed the Worker over its CPU budget once the desk filled up.
carrierApi.get('/summary', async (c) => {
  const sql = getDb(c.env)
  try {
    const closed = CLOSED_STATUSES.map((s) => `'${s}'`).join(',')
    const waiting = WAITING_STATUSES.map((s) => `'${s}'`).join(',')
    const onUs = ON_US_STATUSES.map((s) => `'${s}'`).join(',')
    const [r] = await sql.unsafe(`
      SELECT
        COUNT(*) FILTER (WHERE status NOT IN (${closed}))::int AS open,
        COUNT(*) FILTER (WHERE status IN (${waiting}) AND sla_due_at IS NOT NULL AND sla_due_at < now())::int AS chase_now,
        COUNT(*) FILTER (WHERE status IN (${onUs}))::int AS on_us,
        COUNT(*) FILTER (WHERE customer_update_due)::int AS customer_updates_due,
        COALESCE(SUM(value) FILTER (WHERE status NOT IN (${closed})), 0)::float8 AS at_risk,
        COALESCE(SUM(paid), 0)::float8 AS recovered,
        (SELECT COUNT(*) FROM carrier_drafts d WHERE d.status IN ('draft','approved'))::int AS drafts_ready
      FROM carrier_cases`)
    const perCarrier = await sql.unsafe(`SELECT carrier, COUNT(*)::int AS n FROM carrier_cases WHERE status NOT IN (${closed}) GROUP BY carrier`)
    const byCarrier: Record<string, number> = {}
    for (const row of perCarrier as any[]) byCarrier[CARRIERS[row.carrier as CarrierId]?.label ?? row.carrier] = row.n
    return c.json({
      open: r.open,
      by_carrier: byCarrier,
      chase_now: r.chase_now,
      on_us: r.on_us,
      customer_updates_due: r.customer_updates_due,
      drafts_ready: r.drafts_ready,
      at_risk: Math.round(Number(r.at_risk) * 100) / 100,
      recovered: Math.round(Number(r.recovered) * 100) / 100,
      bank_holidays_until: BANK_HOLIDAYS_UNTIL,
    })
  } catch (e) { if (tableMissing(e)) return c.json({ open: 0, by_carrier: {}, chase_now: 0, on_us: 0, customer_updates_due: 0, drafts_ready: 0, at_risk: 0, recovered: 0, migration_needed: true }); throw e } finally { await sql.end() }
})

// GET /api/carrier/cases/:id → parcel + emails + drafts
carrierApi.get('/cases/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const sql = getDb(c.env)
  try {
    const k = await loadCarrierCase(sql, id)
    if (!k) return c.json({ error: 'Carrier case not found' }, 404)
    const messages = await sql`SELECT m.id, m.direction, m.kind, m.from_addr, m.to_addr, m.subject, m.body, m.summary, m.extracted, m.sent_at, u.name AS sent_by_name
                               FROM carrier_messages m LEFT JOIN users u ON u.id = m.sent_by WHERE m.carrier_case_id = ${id} ORDER BY m.sent_at ASC`
    const drafts = await sql`SELECT d.*, cu.name AS created_by_name, au.name AS approved_by_name, su.name AS sent_by_name FROM carrier_drafts d
                             LEFT JOIN users cu ON cu.id = d.created_by LEFT JOIN users au ON au.id = d.approved_by LEFT JOIN users su ON su.id = d.sent_by
                             WHERE d.carrier_case_id = ${id} ORDER BY d.created_at DESC`
    return c.json({ carrier_case: decorate(k), messages: messages.map((m: any) => ({ ...m, kind_label: inboundLabel(m.kind) })), drafts, status_labels: STATUS_LABEL, issue_labels: ISSUE_LABEL })
  } catch (e) { if (tableMissing(e)) return needMigration(c); throw e } finally { await sql.end() }
})

// GET /api/carrier/for-case/:caseId → the customer case's parcels + what the customer said + prefill for "Open investigation"
carrierApi.get('/for-case/:caseId', async (c) => {
  const caseId = Number(c.req.param('caseId'))
  const sql = getDb(c.env)
  try {
    const [kase] = await sql`SELECT id, order_id, tracking_number, carrier, carrier_issue, carrier_issue_at FROM cases WHERE id = ${caseId}`
    if (!kase) return c.json({ error: 'Case not found' }, 404)
    const rows = (await sql.unsafe(`${LIST_SQL} WHERE cc.case_id = $1 ORDER BY cc.id`, [caseId])).map((k: any) => decorate(k))
    const [last] = await sql`SELECT body FROM messages WHERE case_id = ${caseId} AND direction = 'inbound' AND kind <> 'event' ORDER BY sent_at DESC LIMIT 1`
    const det = detectCarrierIssue(last?.body)
    const [order] = kase.order_id ? await sql`SELECT payload FROM amazon_orders WHERE order_id = ${kase.order_id}` : [null]
    const p = order?.payload ?? {}
    return c.json({
      carrier_cases: rows,
      detection: det ? { ...det, label: ISSUE_LABEL[det.issue] } : kase.carrier_issue ? { issue: kase.carrier_issue, label: ISSUE_LABEL[kase.carrier_issue as keyof typeof ISSUE_LABEL], phrase: null } : null,
      prefill: {
        tracking: kase.tracking_number || p.trackingNumber || null,
        carrier: normaliseCarrier(kase.carrier || p.carrier) ?? (kase.tracking_number ? carrierOfTracking(kase.tracking_number) : null),
        promised_by: p.promisedDelivery?.latest ?? null,
        delivered_at: p.deliveredAt ?? null,
        package_status: p.packageStatus ?? null,
      },
      issue_labels: ISSUE_LABEL,
      status_labels: STATUS_LABEL,
    })
  } catch (e) { if (tableMissing(e)) return c.json({ carrier_cases: [], detection: null, prefill: {}, migration_needed: true, issue_labels: ISSUE_LABEL, status_labels: STATUS_LABEL }); throw e } finally { await sql.end() }
})

// POST /api/carrier/open { case_id, carrier?, tracking?, issue?, force? } → carrier case + investigation draft (not sent)
carrierApi.post('/open', async (c) => {
  const user = c.get('user')
  const b = (await c.req.json().catch(() => ({}))) as { case_id?: number; carrier?: string; tracking?: string; issue?: string; force?: boolean }
  if (!Number.isInteger(Number(b.case_id))) return c.json({ error: 'case_id required' }, 400)
  const sql = getDb(c.env)
  try {
    const r = await openInvestigation(c.env, sql, { caseId: Number(b.case_id), carrier: b.carrier, tracking: b.tracking, issue: b.issue, force: b.force, source: 'manual' }, { id: user.id, name: user.name })
    if (!r.ok) return c.json(r, r.code === 'too_early' ? 409 : r.code === 'not_found' ? 404 : 422)
    return c.json(r, r.created ? 201 : 200)
  } catch (e) { if (tableMissing(e)) return needMigration(c); throw e } finally { await sql.end() }
})

// POST /api/carrier/cases { carrier, tracking, order_id?, issue?, value?, product? } → parcel with no customer case (eBay, Temu, B2B…)
carrierApi.post('/cases', async (c) => {
  const user = c.get('user')
  const b = (await c.req.json().catch(() => ({}))) as Record<string, any>
  const tracking = normaliseTracking(String(b.tracking ?? ''))
  const carrier = normaliseCarrier(b.carrier) ?? carrierOfTracking(tracking)
  if (!tracking || !carrier) return c.json({ error: 'Tracking number and carrier are required' }, 422)
  const sql = getDb(c.env)
  try {
    const orderId = b.order_id ? String(b.order_id).trim().slice(0, 60) : null
    const [kase] = orderId ? await sql`SELECT id FROM cases WHERE order_id = ${orderId} LIMIT 1` : [null]
    const [row] = await sql`INSERT INTO carrier_cases (case_id, carrier, tracking, order_id, issue, product, value, source, created_by, next_action)
      VALUES (${kase?.id ?? null}, ${carrier}, ${tracking}, ${orderId}, ${isIssue(b.issue) ? b.issue : 'lost'}, ${b.product ?? null}, ${b.value != null && b.value !== '' ? Number(b.value) : null}, 'manual', ${user.id}, ${`Send ${CARRIERS[carrier].short} investigation`})
      ON CONFLICT (carrier, tracking) WHERE tracking IS NOT NULL DO NOTHING RETURNING id`
    if (!row) { const [ex] = await sql`SELECT id FROM carrier_cases WHERE carrier = ${carrier} AND tracking = ${tracking}`; return c.json({ error: 'This parcel is already on the carrier desk', carrier_case_id: ex.id }, 409) }
    const d = await prepareDraft(sql, row.id, 'investigation', { id: user.id, name: user.name })
    return c.json({ carrier_case_id: row.id, draft_id: d.id }, 201)
  } catch (e) { if (tableMissing(e)) return needMigration(c); throw e } finally { await sql.end() }
})

// PATCH /api/carrier/cases/:id → staff corrections (status, value, issue, refs …)
const STATUSES = Object.keys(STATUS_LABEL).filter((s) => s !== 'sla_breach')
carrierApi.patch('/cases/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const b = (await c.req.json().catch(() => ({}))) as Record<string, any>
  const up: Record<string, unknown> = {}
  const err: Record<string, string> = {}
  const money = (k: string) => { if (k in b) { const v = b[k]; if (v === '' || v === null) up[k] = null; else if (Number.isFinite(Number(v)) && Number(v) >= 0) up[k] = Number(v).toFixed(2); else err[k] = 'Expected an amount' } }
  const date = (k: string) => { if (k in b) { const v = b[k]; if (!v) up[k] = null; else if (/^\d{4}-\d{2}-\d{2}$/.test(String(v))) up[k] = v; else err[k] = 'Expected YYYY-MM-DD' } }
  const text = (k: string, max = 300) => { if (k in b) up[k] = b[k] == null || b[k] === '' ? null : String(b[k]).trim().slice(0, max) }
  if ('status' in b) { if (STATUSES.includes(b.status)) up.status = b.status; else err.status = 'Invalid status' }
  if ('issue' in b) { if (isIssue(b.issue)) up.issue = b.issue; else err.issue = 'Invalid issue' }
  money('value'); money('claimed'); money('paid'); date('posted_on'); date('delivered_on'); date('paid_on'); date('next_due')
  text('product', 200); text('service', 80); text('claim_ref', 60); text('next_action', 200); text('notes', 2000); text('order_id', 60)
  if ('carrier_refs' in b) up.carrier_refs = (Array.isArray(b.carrier_refs) ? b.carrier_refs : String(b.carrier_refs ?? '').split(/[,\s]+/)).map((x: any) => String(x).trim()).filter((x: string) => /^[\w-]{4,20}$/.test(x))
  if ('customer_update_due' in b) up.customer_update_due = !!b.customer_update_due
  if (Object.keys(err).length) return c.json({ error: 'Validation failed', fields: err }, 422)
  if (!Object.keys(up).length) return c.json({ error: 'Nothing to update' }, 400)
  if (up.status && CLOSED_STATUSES.includes(up.status as CarrierStatus)) up.closed_at = new Date()
  else if (up.status) { up.closed_at = null }
  const sql = getDb(c.env)
  try {
    const cols = Object.keys(up)
    const [row] = await sql.unsafe(`UPDATE carrier_cases SET ${cols.map((k, i) => `${k} = $${i + 2}${k === 'carrier_refs' ? '::text::jsonb' : ''}`).join(', ')} WHERE id = $1 RETURNING id`,
      [id, ...cols.map((k) => (k === 'carrier_refs' ? JSON.stringify(up[k]) : up[k]))] as any[])
    if (!row) return c.json({ error: 'Carrier case not found' }, 404)
    if ('status' in up || 'paid' in up) await sql`INSERT INTO carrier_messages (carrier_case_id, direction, kind, body, summary, sent_by) VALUES (${id}, 'note', 'note', ${`Updated by ${c.get('user').name}: ${cols.join(', ')}`}, ${`${c.get('user').name} set ${'status' in up ? `status → ${STATUS_LABEL[up.status as CarrierStatus]}` : ''}${'paid' in up ? ` paid → £${up.paid}` : ''}`.trim()}, ${c.get('user').id})`
    return c.json({ carrier_case: decorate(await loadCarrierCase(sql, id)) })
  } finally { await sql.end() }
})

// POST /api/carrier/cases/:id/drafts { kind, regenerate? } → prepare (never send) an email or claim pack
const KINDS: DraftKind[] = ['investigation', 'chase', 'challenge', 'info_reply', 'claim_pack', 'postage_refund']
carrierApi.post('/cases/:id/drafts', async (c) => {
  const id = Number(c.req.param('id'))
  const user = c.get('user')
  const b = (await c.req.json().catch(() => ({}))) as { kind?: DraftKind; regenerate?: boolean }
  if (!KINDS.includes(b.kind as DraftKind)) return c.json({ error: 'kind must be one of ' + KINDS.join(', ') }, 400)
  const sql = getDb(c.env)
  try {
    if (!(await loadCarrierCase(sql, id))) return c.json({ error: 'Carrier case not found' }, 404)
    const r = await prepareDraft(sql, id, b.kind!, { id: user.id, name: user.name }, { regenerate: b.regenerate })
    const [d] = await sql`SELECT * FROM carrier_drafts WHERE id = ${r.id}`
    return c.json({ draft: d, existing: r.existing }, r.existing ? 200 : 201)
  } finally { await sql.end() }
})

// PATCH /api/carrier/drafts/:id { to_address?, subject?, body? } → edit; editing an approved draft un-approves it
carrierApi.patch('/drafts/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const user = c.get('user')
  const b = (await c.req.json().catch(() => ({}))) as { to_address?: string; subject?: string; body?: string }
  const sql = getDb(c.env)
  try {
    const [d] = await sql`SELECT * FROM carrier_drafts WHERE id = ${id}`
    if (!d) return c.json({ error: 'Draft not found' }, 404)
    if (!['draft', 'approved'].includes(d.status)) return c.json({ error: `Draft is ${d.status}` }, 409)
    const to = b.to_address !== undefined ? String(b.to_address).trim().slice(0, 200) || null : d.to_address
    const subject = b.subject !== undefined ? String(b.subject).replace(/[\r\n]+/g, ' ').trim().slice(0, 300) : d.subject
    const body = b.body !== undefined ? String(b.body).trim().slice(0, 20000) : d.body
    if (!subject || !body) return c.json({ error: 'Subject and body are required' }, 422)
    await sql`UPDATE carrier_drafts SET to_address = ${to}, subject = ${subject}, body = ${body}, edited_by = ${user.id}, status = 'draft', approved_by = NULL, approved_at = NULL WHERE id = ${id}`
    const [out] = await sql`SELECT * FROM carrier_drafts WHERE id = ${id}`
    return c.json({ draft: out })
  } finally { await sql.end() }
})

carrierApi.post('/drafts/:id/discard', async (c) => {
  const id = Number(c.req.param('id'))
  const sql = getDb(c.env)
  try {
    const [d] = await sql`UPDATE carrier_drafts SET status = 'discarded' WHERE id = ${id} AND status IN ('draft','approved') RETURNING id`
    if (!d) return c.json({ error: 'Draft not found or already sent' }, 404)
    return c.json({ ok: true })
  } finally { await sql.end() }
})

/**
 * POST /api/carrier/drafts/:id/send { confirm_subject, confirm_body, confirm_to } — one click = approve + send.
 * Gates: the text on screen equals the stored text; recipient is a carrier domain; no [MISSING: …] left; manager for
 * flagged drafts; claim packs are never emailed; one send per draft (atomic claim).
 */
carrierApi.post('/drafts/:id/send', async (c) => {
  const id = Number(c.req.param('id'))
  const user = c.get('user')
  const b = (await c.req.json().catch(() => ({}))) as { confirm_subject?: string; confirm_body?: string; confirm_to?: string }
  const sql = getDb(c.env)
  try {
    const [d] = await sql`SELECT * FROM carrier_drafts WHERE id = ${id}`
    if (!d) return c.json({ error: 'Draft not found' }, 404)
    if (d.status === 'sent') return c.json({ error: 'Already sent' }, 409)
    if (!['draft', 'approved'].includes(d.status)) return c.json({ error: `Draft is ${d.status}` }, 409)
    if (d.kind === 'claim_pack') return c.json({ error: 'A claim pack is pasted into the carrier\'s claims portal, not emailed. Copy it, submit the claim, then press "Mark claim submitted".' }, 400)
    if (d.needs_manager && user.role !== 'manager') return c.json({ error: 'This email needs a manager to approve it.' }, 403)
    if ((b.confirm_body ?? '').trim() !== String(d.body).trim() || (b.confirm_subject ?? '').trim() !== String(d.subject).trim() || (b.confirm_to ?? '').trim() !== String(d.to_address ?? '').trim())
      return c.json({ error: 'The email on screen differs from the saved draft. Reload and try again.' }, 409)
    if (/\[MISSING:[^\]]*\]/i.test(d.body)) return c.json({ error: 'Fill in the [MISSING: …] parts before sending.' }, 422)
    const settings = await getSettings(sql)
    if (!d.to_address || !recipientAllowed(d.to_address, settings)) return c.json({ error: `"${d.to_address ?? ''}" is not a carrier address. Carrier emails can only go to Royal Mail, DPD, FedEx, Evri or Parcelforce domains (a manager can add others in Settings).` }, 422)
    const k = await loadCarrierCase(sql, d.carrier_case_id)

    // Sending mailbox: setting → first mailbox flagged for carrier mail → default
    const all = await listConnections(sql)
    const conn = all.find((m) => m.id === settings.send_mailbox_id) ?? all.find((m) => m.carrier_mail && m.enabled) ?? all.find((m) => m.is_default) ?? all[0]
    if (!conn) return c.json({ error: 'No Gmail mailbox is connected.' }, 503)
    // Reply inside the carrier's own thread when we have it in this mailbox (keeps their case reference attached)
    const [prev] = d.kind === 'investigation' ? [null] : await sql`SELECT gmail_thread_id, rfc_message_id FROM carrier_messages
      WHERE carrier_case_id = ${k.id} AND mailbox_id = ${conn.id} AND direction IN ('inbound','outbound') AND gmail_thread_id IS NOT NULL ORDER BY sent_at DESC LIMIT 1`
    const refs = prev ? (await sql`SELECT rfc_message_id FROM carrier_messages WHERE gmail_thread_id = ${prev.gmail_thread_id} AND rfc_message_id IS NOT NULL ORDER BY sent_at`).map((r: any) => r.rfc_message_id).join(' ') : ''

    const claimed = await sql`UPDATE carrier_drafts SET status = 'sending', approved_by = ${user.id}, approved_at = now() WHERE id = ${id} AND status IN ('draft','approved') RETURNING id`
    if (!claimed.length) return c.json({ error: 'Already being sent' }, 409)
    let sent: { id: string; threadId: string }
    let rfcId: string | null = null
    try {
      const { token } = await accessToken(c.env, sql, conn.id)
      sent = await sendEmail(token, {
        fromName: settings.from_name, from: settings.from_address || conn.email_address, to: d.to_address, cc: settings.cc,
        subject: d.subject, body: d.body, threadId: prev?.gmail_thread_id || undefined, inReplyTo: prev?.rfc_message_id || undefined, references: refs || undefined,
      })
      rfcId = await messageIdHeader(token, sent.id).catch(() => null)
    } catch (e: any) {
      await sql`UPDATE carrier_drafts SET status = 'draft', approved_by = NULL, approved_at = NULL WHERE id = ${id} AND status = 'sending'`
      return c.json({ error: `Send failed: ${e.message}` }, 502)
    }
    const at = new Date()
    await sql.begin(async (tx) => {
      await tx`UPDATE carrier_drafts SET status = 'sent', sent_by = ${user.id}, sent_at = ${at}, sent_gmail_message_id = ${sent.id} WHERE id = ${id}`
      await tx`INSERT INTO carrier_messages (carrier_case_id, direction, kind, from_addr, to_addr, subject, body, summary, gmail_message_id, rfc_message_id, gmail_thread_id, mailbox_id, sent_by, sent_at)
               VALUES (${k.id}, 'outbound', ${d.kind}, ${settings.from_address || conn.email_address}, ${d.to_address}, ${d.subject}, ${d.body},
                       ${`${user.name} sent ${d.kind.replace('_', ' ')} to ${CARRIERS[k.carrier as CarrierId].label}`}, ${sent.id}, ${rfcId}, ${sent.threadId}, ${conn.id}, ${user.id}, ${at})`
    })
    await applyPatch(sql, k.id, { ...onOutbound(k, d.kind, at), gmail_thread_id: sent.threadId, mailbox_id: conn.id })
    if (k.case_id && d.kind === 'investigation')
      await sql`INSERT INTO messages (case_id, direction, sender, body, sent_at, kind) VALUES (${k.case_id}, 'outbound', ${`Carrier update · ${CARRIERS[k.carrier as CarrierId].label}`},
                ${`We asked ${CARRIERS[k.carrier as CarrierId].label} to investigate the parcel (${k.tracking}). Their reply is due within ${CARRIERS[k.carrier as CarrierId].replyDays} working days.`}, ${at}, 'event')`
    return c.json({ ok: true, gmail_message_id: sent.id, carrier_case: decorate(await loadCarrierCase(sql, k.id)) })
  } finally { await sql.end() }
})

// POST /api/carrier/cases/:id/claim-submitted { claim_ref?, claimed? } → after pasting the claim pack into the carrier's portal
carrierApi.post('/cases/:id/claim-submitted', async (c) => {
  const id = Number(c.req.param('id'))
  const user = c.get('user')
  const b = (await c.req.json().catch(() => ({}))) as { claim_ref?: string; claimed?: number | string }
  const sql = getDb(c.env)
  try {
    const k = await loadCarrierCase(sql, id)
    if (!k) return c.json({ error: 'Carrier case not found' }, 404)
    const claimed = b.claimed !== undefined && b.claimed !== '' && Number.isFinite(Number(b.claimed)) ? Number(b.claimed) : null
    const at = new Date()
    await applyPatch(sql, id, onClaimSubmitted(k, at, b.claim_ref ? String(b.claim_ref).trim().slice(0, 60) : null, claimed))
    await sql`UPDATE carrier_drafts SET status = 'sent', sent_by = ${user.id}, sent_at = ${at} WHERE carrier_case_id = ${id} AND kind = 'claim_pack' AND status IN ('draft','approved')`
    await sql`INSERT INTO carrier_messages (carrier_case_id, direction, kind, body, summary, sent_by, sent_at) VALUES (${id}, 'note', 'claim_submitted',
              ${`Claim submitted${b.claim_ref ? ` (ref ${b.claim_ref})` : ''}${claimed != null ? ` for £${claimed.toFixed(2)}` : ''}`}, ${`${user.name} submitted the claim${b.claim_ref ? ` ${b.claim_ref}` : ''}`}, ${user.id}, ${at})`
    return c.json({ carrier_case: decorate(await loadCarrierCase(sql, id)) })
  } finally { await sql.end() }
})

// POST /api/carrier/cases/:id/note { text }
carrierApi.post('/cases/:id/note', async (c) => {
  const id = Number(c.req.param('id'))
  const user = c.get('user')
  const b = (await c.req.json().catch(() => ({}))) as { text?: string }
  const text = String(b.text ?? '').trim().slice(0, 2000)
  if (!text) return c.json({ error: 'Note is empty' }, 400)
  const sql = getDb(c.env)
  try {
    await sql`INSERT INTO carrier_messages (carrier_case_id, direction, kind, body, summary, sent_by) VALUES (${id}, 'note', 'note', ${text}, ${`${user.name}: ${text.slice(0, 100)}`}, ${user.id})`
    return c.json({ ok: true })
  } finally { await sql.end() }
})

// POST /api/carrier/sync { days? } → poll carrier mailboxes now, then prepare due drafts (read-only towards Gmail)
carrierApi.post('/sync', async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { days?: number }
  const days = b.days ? Math.min(Math.max(Number(b.days) || 1, 1), 120) : undefined
  const sql = getDb(c.env)
  try {
    const r = await syncCarrierMail(c.env, sql, { lookbackDays: days })
    const p = await prepareDueDrafts(sql)
    return c.json({ ...r, ...p })
  } catch (e) { if (tableMissing(e)) return needMigration(c); throw e } finally { await sql.end() }
})

// GET/PUT /api/carrier/settings
carrierApi.get('/settings', async (c) => {
  const sql = getDb(c.env)
  try {
    const s = await getSettings(sql)
    const mailboxes = (await listConnections(sql)).map((m) => ({ id: m.id, label: m.label, email: m.email_address, carrier_mail: !!m.carrier_mail, enabled: m.enabled }))
    return c.json({ settings: s, defaults: Object.fromEntries(Object.values(CARRIERS).map((x) => [x.id, { to: x.investigationTo, reply_days: x.replyDays, claim_days: x.claimDecisionDays, label: x.label }])), effective_to: Object.fromEntries(Object.keys(CARRIERS).map((id) => [id, carrierAddress(s, id as CarrierId)])), mailboxes, bank_holidays_until: BANK_HOLIDAYS_UNTIL })
  } catch (e) { if (tableMissing(e)) return c.json({ settings: DEFAULT_SETTINGS, migration_needed: true }); throw e } finally { await sql.end() }
})
carrierApi.put('/settings', requireManager, async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Partial<CarrierSettings>
  const patch: Partial<CarrierSettings> = {}
  const emailOk = (v: string) => /^[^@\s<>]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(v)
  if ('from_address' in b) { const v = String(b.from_address ?? '').trim(); if (v && !emailOk(v)) return c.json({ error: 'From address is not an email address' }, 422); patch.from_address = v || null }
  if ('from_name' in b) patch.from_name = String(b.from_name ?? '').replace(/[\r\n<>"]/g, '').trim().slice(0, 60) || DEFAULT_SETTINGS.from_name
  if ('signature' in b) patch.signature = String(b.signature ?? '').slice(0, 600)
  if ('cc' in b) { const list = (Array.isArray(b.cc) ? b.cc : String(b.cc ?? '').split(/[,\s]+/)).map((x) => String(x).trim()).filter(Boolean); if (list.some((x) => !emailOk(x))) return c.json({ error: 'Cc must be email addresses' }, 422); patch.cc = list.slice(0, 5) }
  if ('send_mailbox_id' in b) patch.send_mailbox_id = b.send_mailbox_id ? Number(b.send_mailbox_id) : null
  if ('auto_open' in b) patch.auto_open = !!b.auto_open
  if ('auto_chase' in b) patch.auto_chase = !!b.auto_chase
  if ('extra_allowed_domains' in b) patch.extra_allowed_domains = (Array.isArray(b.extra_allowed_domains) ? b.extra_allowed_domains : String(b.extra_allowed_domains ?? '').split(/[,\s]+/)).map((x) => String(x).trim().toLowerCase().replace(/^@/, '')).filter((x) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(x)).slice(0, 10)
  if (b.addresses && typeof b.addresses === 'object') {
    const a: Partial<Record<CarrierId, string>> = {}
    for (const [k, v] of Object.entries(b.addresses)) { if (!(k in CARRIERS)) continue; const t = String(v ?? '').trim(); if (t && !emailOk(t)) return c.json({ error: `${k}: not an email address` }, 422); if (t) a[k as CarrierId] = t }
    patch.addresses = a
  }
  const sql = getDb(c.env)
  try { return c.json({ settings: await saveSettings(sql, patch, c.get('user').id) }) } finally { await sql.end() }
})

// POST /api/carrier/import (manager) { cases: [...] } — one-off import from the old "Carrier Claims Desk" dashboard export
const LEGACY_STATUS: Record<string, CarrierStatus> = {
  'Paid': 'paid', 'Partially paid': 'partially_paid', 'Rejected': 'rejected', 'Escalated': 'escalated', 'Claim submitted': 'claim_submitted',
  'Claim form needed': 'claim_form_needed', 'Action needed from us': 'action_needed', 'SLA breach': 'awaiting_carrier', 'Awaiting carrier': 'awaiting_carrier', 'Closed': 'closed',
}
const LEGACY_ISSUE: Record<string, string> = {
  'Lost / no tracking update': 'lost', 'Delivered not received': 'delivered_not_received', 'Empty parcel / missing contents': 'empty_parcel', 'Damaged': 'damaged',
  'Wrong item': 'wrong_item', 'Proof of delivery request': 'pod_request', 'Return to sender': 'return_to_sender', 'Postage refund': 'postage_refund', 'Other': 'other',
}
const LEGACY_CARRIER: Record<string, CarrierId> = { 'Royal Mail': 'royal_mail', 'DPD': 'dpd', 'FedEx': 'fedex' }
carrierApi.post('/import', requireManager, async (c) => {
  // The UI sends the file in chunks (IMPORT_CHUNK parcels per request) so one request never exceeds the Worker's
  // CPU budget — a single 120-parcel import used ~1.7 s CPU and tripped Cloudflare's limit, which then 503'd every request for minutes.
  const b = (await c.req.json().catch(() => ({}))) as { cases?: any[] }
  const list = Array.isArray(b.cases) ? b.cases.slice(0, 1000) : []
  if (!list.length) return c.json({ error: 'No cases in the file' }, 400)
  const sql = getDb(c.env)
  const out = { created: 0, updated: 0, skipped: [] as string[] }
  const ts = (d: any) => (d ? new Date(`${String(d).slice(0, 10)}T12:00:00Z`) : null)
  try {
    // One lookup for all order ids and all tracking numbers in this chunk, instead of two queries per parcel
    const orderIds = [...new Set(list.map((x) => (x.orderId ? String(x.orderId).slice(0, 60) : null)).filter(Boolean))] as string[]
    const caseByOrder = new Map<string, number>()
    if (orderIds.length) for (const r of await sql`SELECT DISTINCT ON (order_id) order_id, id FROM cases WHERE order_id = ANY(string_to_array(${orderIds.join('\u0001')}, E'\\x01')) ORDER BY order_id, id`) caseByOrder.set(r.order_id, r.id)
    const keys = list.map((x) => ({ carrier: LEGACY_CARRIER[x.carrier], tracking: x.tracking ? normaliseTracking(String(x.tracking)) : null })).filter((k) => k.carrier && k.tracking)
    const existingByKey = new Map<string, { id: number; source: string }>()
    if (keys.length) for (const r of await sql`SELECT id, source, carrier, tracking FROM carrier_cases WHERE carrier = ANY(string_to_array(${keys.map((k) => k.carrier).join(',')}, ',')) AND tracking = ANY(string_to_array(${keys.map((k) => k.tracking).join('\u0001')}, E'\\x01'))`) existingByKey.set(`${r.carrier}:${r.tracking}`, r)

    for (const x of list) {
      const carrier = LEGACY_CARRIER[x.carrier]
      const status = LEGACY_STATUS[x.status]
      if (!carrier || !status) { out.skipped.push(`${x.id ?? x.tracking}: unknown carrier/status`); continue }
      const tracking = x.tracking ? normaliseTracking(String(x.tracking)) : null
      const orderId = x.orderId ? String(x.orderId).slice(0, 60) : null
      const refs = (x.caseRefs ?? []).map(String)
      const vals = {
        case_id: (orderId && caseByOrder.get(orderId)) ?? null, carrier, tracking, order_id: orderId, issue: LEGACY_ISSUE[x.issue] ?? 'other', status, product: x.product ?? null,
        value: x.value ?? null, posted_on: x.posted ?? null, carrier_refs: sql.json(refs) as any, claim_ref: x.claimRef ?? null,
        raised_at: ts(x.raised), last_us_at: ts(x.lastUs), last_carrier_at: ts(x.lastCarrier),
        carrier_reply_type: x.carrierReplyType === 'Auto-ack only' ? 'auto_ack' : x.carrierReplyType === 'Replied' ? 'replied' : x.carrierReplyType === 'Decision' ? 'decision' : null,
        sla_due_at: x.slaDue ? new Date(`${x.slaDue}T22:59:59Z`) : null, claimed: x.claimed ?? null, paid: x.paid ?? null, paid_on: x.paidDate ?? null,
        next_action: x.nextAction ?? null, next_due: x.nextDue ?? null, notes: x.notes ?? null, source: 'import',
        closed_at: CLOSED_STATUSES.includes(status) ? ts(x.closedOn) ?? new Date() : null,
      }
      const existing = tracking
        ? existingByKey.get(`${carrier}:${tracking}`)
        : refs.length ? (await sql`SELECT id, source FROM carrier_cases WHERE carrier_refs ?| string_to_array(${refs.join('\u0001')}, E'\\x01') AND tracking IS NULL LIMIT 1`)[0] : undefined
      let id: number
      if (existing && existing.source === 'import') { await sql`UPDATE carrier_cases SET ${sql(vals as any)} WHERE id = ${existing.id}`; id = existing.id; out.updated++ }
      else if (existing) {
        // ReplyIQ already tracks this parcel from live email: its status is newer. Only fill gaps and merge references.
        await sql`UPDATE carrier_cases SET case_id = COALESCE(case_id, ${vals.case_id}), order_id = COALESCE(order_id, ${vals.order_id}), product = COALESCE(product, ${vals.product}),
                    value = COALESCE(value, ${vals.value}), posted_on = COALESCE(posted_on, ${vals.posted_on}), claim_ref = COALESCE(claim_ref, ${vals.claim_ref}),
                    raised_at = LEAST(raised_at, ${vals.raised_at}), notes = COALESCE(notes, ${vals.notes}),
                    carrier_refs = (SELECT COALESCE(jsonb_agg(DISTINCT r), '[]'::jsonb) FROM jsonb_array_elements_text(carrier_refs || ${JSON.stringify(refs)}::text::jsonb) r)
                  WHERE id = ${existing.id}`
        id = existing.id; out.updated++
      }
      else { const [r] = await sql`INSERT INTO carrier_cases ${sql(vals as any)} RETURNING id`; id = r.id; out.created++ }
      // Timeline notes: one statement per parcel (not one per note)
      const events = (x.timeline ?? []).slice(-15)
      if (events.length) {
        const kinds = events.map((ev: any) => 'import_' + (ev.by ?? 'system'))
        const clean = (t: any) => String(t ?? '').replace(/\u0001/g, ' ')
        const bodies = events.map((ev: any) => clean(ev.text).slice(0, 500))
        const summaries = events.map((ev: any) => clean(ev.text).slice(0, 200))
        const when = events.map((ev: any) => (ts(ev.d) ?? new Date()).toISOString())
        await sql`INSERT INTO carrier_messages (carrier_case_id, direction, kind, body, summary, sent_at)
                  SELECT ${id}, 'note', n.kind, n.body, n.summary, n.sent_at::timestamptz
                  FROM unnest(string_to_array(${kinds.join('\u0001')}, E'\\x01'), string_to_array(${bodies.join('\u0001')}, E'\\x01'), string_to_array(${summaries.join('\u0001')}, E'\\x01'), string_to_array(${when.join('\u0001')}, E'\\x01')) AS n(kind, body, summary, sent_at)
                  WHERE NOT EXISTS (SELECT 1 FROM carrier_messages m WHERE m.carrier_case_id = ${id} AND m.kind LIKE 'import_%' AND m.body = n.body)`
      }
    }
    return c.json(out)
  } catch (e) { if (tableMissing(e)) return needMigration(c); throw e } finally { await sql.end() }
})
