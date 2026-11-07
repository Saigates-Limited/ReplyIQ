// Physical returns API (Part 1). Mounted at /api/returns. Nothing here talks to OpenAI or sends email.
import { Hono } from 'hono'
import { getDb, type Bindings } from '../db'
import { requireManager, type Vars } from '../auth'
import { LIST_SQL, decorate, loadReturn, archiveReturn, hasReturnArchive, expectedFromNotice, createReturn, receive, updateItem, setStatus, clearManager, loadSkus, loadSuppliers, ensureSku, reports, exportCsv, tableMissing } from '../returns/service'
import { parseCsv, cleanRow, type CleanRow } from '../returns/importer'
import { STATUS_LABEL, REASON_LABEL, CABLE_LABEL, OUTCOME_LABEL, DISPOSITION_LABEL, RETURN_STATUSES } from '../returns/rules'
import { checkImei } from '../returns/imei'

export const returnsApi = new Hono<{ Bindings: Bindings; Variables: Vars }>()
const needMigration = (c: any) => c.json({ error: 'Run db/migrations/0017_returns_and_refunds.sql in Supabase first.' }, 503)
const LABELS = { status: STATUS_LABEL, reason: REASON_LABEL, cable: CABLE_LABEL, outcome: OUTCOME_LABEL, disposition: DISPOSITION_LABEL }

// GET /api/returns?view=open|expected|received|inspected|outcome_agreed|closed|overdue|manager|all&q=
returnsApi.get('/', async (c) => {
  const view = c.req.query('view') ?? 'open'
  const q = (c.req.query('q') ?? '').trim()
  const sql = getDb(c.env)
  try {
    const hasArch = await hasReturnArchive(sql)
    const archWhere = !hasArch ? '' : view === 'archived' ? 'WHERE r.archived_at IS NOT NULL' : 'WHERE r.archived_at IS NULL'
    const rows = (await sql.unsafe(`${LIST_SQL} ${archWhere} ORDER BY COALESCE(r.received_at, r.created_at) DESC LIMIT 2000`)).map((r: any) => decorate(r))
    const qd = q.replace(/\D/g, '')
    const filtered = rows.filter((r: any) =>
      (view === 'all' || view === 'archived' ? true
        : view === 'open' ? r.status !== 'closed'
        : view === 'overdue' ? r.overdue
        : view === 'manager' ? r.manager_items > 0 || r.lock_overdue
        : r.status === view) &&
      (!q || r.order_id.includes(q) || (qd.length >= 6 && (r.imeis ?? '').replace(/\D/g, '').includes(qd)) || (r.return_tracking ?? '').toLowerCase().includes(q.toLowerCase()) || (r.sku ?? '').toLowerCase().includes(q.toLowerCase())))
    // Overdue first, then manager, then newest
    filtered.sort((a: any, b: any) => Number(b.overdue) - Number(a.overdue) || Number(b.manager_items > 0) - Number(a.manager_items > 0))
    return c.json({ returns: filtered, now: new Date().toISOString(), labels: LABELS })
  } catch (e) { if (tableMissing(e)) return needMigration(c); throw e } finally { await sql.end() }
})

// GET /api/returns/summary → counts for badges / dashboard
returnsApi.get('/summary', async (c) => {
  const sql = getDb(c.env)
  try {
    const rows = (await sql.unsafe(`SELECT r.id, r.status, r.received_at, (SELECT COUNT(*)::int FROM return_items i WHERE i.return_id = r.id AND i.needs_manager AND i.manager_cleared_at IS NULL) AS manager_items FROM returns r WHERE r.status <> 'closed'${(await hasReturnArchive(sql)) ? ' AND r.archived_at IS NULL' : ''}`)).map((r: any) => decorate(r))
    const [refunds] = await sql`SELECT COUNT(*) FILTER (WHERE status IN ('alert','chasing','claim_filed'))::int AS alerts, COUNT(*) FILTER (WHERE status = 'open')::int AS unreconciled FROM amazon_events WHERE kind = 'refund_initiated'`.catch(() => [{ alerts: 0, unreconciled: 0 }])
    return c.json({
      open: rows.length, expected: rows.filter((r: any) => r.status === 'expected').length, received: rows.filter((r: any) => r.status === 'received').length,
      inspected: rows.filter((r: any) => r.status === 'inspected').length, outcome_agreed: rows.filter((r: any) => r.status === 'outcome_agreed').length,
      overdue: rows.filter((r: any) => r.overdue).length, manager: rows.filter((r: any) => r.manager_items > 0).length,
      refund_alerts: refunds.alerts, refund_unreconciled: refunds.unreconciled,
    })
  } catch (e) { if (tableMissing(e)) return c.json({ open: 0, overdue: 0, manager: 0, refund_alerts: 0, migration_needed: true }); throw e } finally { await sql.end() }
})

// GET /api/returns/lookups
returnsApi.get('/lookups', async (c) => {
  const sql = getDb(c.env)
  try { return c.json({ skus: await loadSkus(sql), suppliers: await loadSuppliers(sql), labels: LABELS, statuses: RETURN_STATUSES }) }
  catch (e) { if (tableMissing(e)) return needMigration(c); throw e } finally { await sql.end() }
})
// POST /api/returns/lookups/sku {sku, model} · /supplier {code, label} (manager)
returnsApi.post('/lookups/sku', requireManager, async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { sku?: string; model?: string }
  const sku = String(b.sku ?? '').trim().toUpperCase()
  if (!/^[A-Z0-9][A-Z0-9._-]{2,40}$/.test(sku)) return c.json({ error: 'SKU: letters, digits, - . _ only' }, 422)
  const sql = getDb(c.env)
  try { await ensureSku(sql, sku, b.model ?? null, c.get('user').id); return c.json({ skus: await loadSkus(sql) }) } finally { await sql.end() }
})
returnsApi.post('/lookups/supplier', requireManager, async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { code?: string; label?: string }
  const code = String(b.code ?? '').trim().toUpperCase()
  if (!/^[A-Z]{2,4}\d{3}$/.test(code)) return c.json({ error: 'Supplier code looks like SW001 (2–4 letters + 3 digits)' }, 422)
  const sql = getDb(c.env)
  try { await sql`INSERT INTO return_supplier_codes (code, label, created_by) VALUES (${code}, ${b.label ?? null}, ${c.get('user').id}) ON CONFLICT (code) DO UPDATE SET active = TRUE, label = COALESCE(EXCLUDED.label, return_supplier_codes.label)`; return c.json({ suppliers: await loadSuppliers(sql) }) } finally { await sql.end() }
})

// GET /api/returns/reports?from=&to=
returnsApi.get('/reports', async (c) => {
  const sql = getDb(c.env)
  try { return c.json(await reports(sql, c.req.query('from') || null, c.req.query('to') || null)) }
  catch (e) { if (tableMissing(e)) return needMigration(c); throw e } finally { await sql.end() }
})
// GET /api/returns/export.csv?from=&to=
returnsApi.get('/export.csv', async (c) => {
  const sql = getDb(c.env)
  try {
    // legacy_customer_name (from the old sheet) is left out unless a manager explicitly asks with ?include_names=1
    const includeNames = c.req.query('include_names') === '1' && c.get('user').role === 'manager'
    const csv = await exportCsv(sql, c.req.query('from') || null, c.req.query('to') || null, includeNames)
    return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="returns-${new Date().toISOString().slice(0, 10)}.csv"` } })
  } catch (e) { if (tableMissing(e)) return needMigration(c); throw e } finally { await sql.end() }
})

// GET /api/returns/for-case/:caseId — panel on the case screen
returnsApi.get('/for-case/:caseId', async (c) => {
  const caseId = Number(c.req.param('caseId'))
  const sql = getDb(c.env)
  try {
    const [k] = await sql`SELECT order_id FROM cases WHERE id = ${caseId}`
    if (!k) return c.json({ error: 'Case not found' }, 404)
    const rows = (await sql.unsafe(`${LIST_SQL} WHERE r.case_id = $1 OR r.order_id = $2 ORDER BY r.created_at DESC`, [caseId, k.order_id])).map((r: any) => decorate(r))
    return c.json({ returns: rows, labels: LABELS })
  } catch (e) { if (tableMissing(e)) return c.json({ returns: [], migration_needed: true }); throw e } finally { await sql.end() }
})

// GET /api/returns/:id
returnsApi.get('/:id{[0-9]+}', async (c) => {
  const sql = getDb(c.env)
  try { const r = await loadReturn(sql, Number(c.req.param('id'))); return r ? c.json({ return: r, labels: LABELS, now: new Date().toISOString() }) : c.json({ error: 'Return not found' }, 404) }
  catch (e) { if (tableMissing(e)) return needMigration(c); throw e } finally { await sql.end() }
})

// POST /api/returns — manual "Expected" (or straight to Received when the parcel is in hand)
returnsApi.post('/', async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as any
  const order = String(b.order_id ?? '').trim()
  if (!/^\d{3}-\d{7}-\d{7}$/.test(order)) return c.json({ error: 'Order ID must look like 123-1234567-1234567' }, 422)
  if (b.imei) { const chk = checkImei(b.imei); if (!chk.ok) return c.json({ error: `IMEI: ${chk.reason}` }, 422) }
  const sql = getDb(c.env)
  try {
    const user = c.get('user')
    const id = await createReturn(sql, { order_id: order, order_date: b.order_date || null, delivery_date: b.delivery_date || null, sku: b.sku || null, asin: b.asin || null, quantity: b.quantity, amazon_reason: b.amazon_reason || null, return_tracking: b.return_tracking || null, notes: b.notes || null, status: b.received ? 'received' : 'expected' }, user.id)
    if (b.imei) await sql`UPDATE return_items SET imei = ${checkImei(b.imei).ok ? (checkImei(b.imei) as any).imei : null} WHERE return_id = ${id} AND item_no = 1`
    return c.json({ return: await loadReturn(sql, id) }, 201)
  } catch (e) { if (tableMissing(e)) return needMigration(c); throw e } finally { await sql.end() }
})

// POST /api/returns/:id/receive {return_tracking?, imeis?: [], imei_matches?: []}
returnsApi.post('/:id{[0-9]+}/receive', async (c) => {
  const id = Number(c.req.param('id')), b = (await c.req.json().catch(() => ({}))) as any
  const sql = getDb(c.env)
  try { const r = await receive(sql, id, c.get('user').id, b); if ('error' in r) return c.json({ error: r.error }, r.status); return c.json({ ...r, return: await loadReturn(sql, id) }) }
  finally { await sql.end() }
})
// PATCH /api/returns/:id {notes?, return_tracking?, sku?, delivery_date?, order_date?, status?}
returnsApi.patch('/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id')), b = (await c.req.json().catch(() => ({}))) as any
  const sql = getDb(c.env)
  try {
    const user = c.get('user')
    if ('status' in b) { const r = await setStatus(sql, id, user.id, String(b.status)); if ('error' in r) return c.json({ error: r.error }, r.status) }
    const up: Record<string, any> = {}
    if ('notes' in b) up.notes = b.notes ? String(b.notes).slice(0, 8000) : null
    if ('return_tracking' in b) up.return_tracking = b.return_tracking ? String(b.return_tracking).trim().slice(0, 60) : null
    if ('sku' in b) { up.sku = b.sku ? String(b.sku).toUpperCase() : null; if (up.sku) await ensureSku(sql, up.sku, null, user.id) }
    for (const k of ['delivery_date', 'order_date']) if (k in b) up[k] = b[k] ? String(b[k]).slice(0, 10) : null
    if (Object.keys(up).length) await sql`UPDATE returns SET ${sql(up)} WHERE id = ${id}`
    return c.json({ return: await loadReturn(sql, id) })
  } finally { await sql.end() }
})
// PATCH /api/returns/items/:itemId — inspection / outcome / stock
returnsApi.patch('/items/:itemId{[0-9]+}', async (c) => {
  const itemId = Number(c.req.param('itemId')), b = (await c.req.json().catch(() => ({}))) as any
  const sql = getDb(c.env)
  try {
    const user = c.get('user')
    const r = await updateItem(sql, itemId, user.id, user.role, b)
    if ('error' in r) return c.json({ error: r.error, fields: (r as any).fields }, r.status)
    const [row] = await sql`SELECT return_id FROM return_items WHERE id = ${itemId}`
    return c.json({ ...r, return: await loadReturn(sql, row.return_id) })
  } finally { await sql.end() }
})
// POST /api/returns/items/:itemId/add (quantity grew) · /manager-clear (manager)
returnsApi.post('/:id{[0-9]+}/items', async (c) => {
  const id = Number(c.req.param('id'))
  const sql = getDb(c.env)
  try { const [n] = await sql`SELECT COALESCE(MAX(item_no), 0) + 1 AS next FROM return_items WHERE return_id = ${id}`; await sql`INSERT INTO return_items (return_id, item_no) VALUES (${id}, ${n.next})`; await sql`UPDATE returns SET quantity = ${n.next} WHERE id = ${id}`; return c.json({ return: await loadReturn(sql, id) }) } finally { await sql.end() }
})
returnsApi.post('/items/:itemId{[0-9]+}/manager-clear', requireManager, async (c) => {
  const itemId = Number(c.req.param('itemId'))
  const sql = getDb(c.env)
  try { await clearManager(sql, itemId, c.get('user').id); const [row] = await sql`SELECT return_id FROM return_items WHERE id = ${itemId}`; return c.json({ return: await loadReturn(sql, row.return_id) }) } finally { await sql.end() }
})
// POST /api/returns/items/:itemId/photos {attachment_id} — link a customer photo already on the case
returnsApi.post('/items/:itemId{[0-9]+}/photos', async (c) => {
  const itemId = Number(c.req.param('itemId')), b = (await c.req.json().catch(() => ({}))) as { attachment_id?: number }
  const sql = getDb(c.env)
  try {
    const [a] = await sql`SELECT id, filename, mime_type, size_bytes FROM attachments WHERE id = ${Number(b.attachment_id)}`
    if (!a) return c.json({ error: 'Attachment not found' }, 404)
    await sql`INSERT INTO return_photos (return_item_id, attachment_id, filename, mime_type, size_bytes, uploaded_by) VALUES (${itemId}, ${a.id}, ${a.filename}, ${a.mime_type}, ${a.size_bytes}, ${c.get('user').id})`
    const [row] = await sql`SELECT return_id FROM return_items WHERE id = ${itemId}`
    return c.json({ return: await loadReturn(sql, row.return_id) })
  } finally { await sql.end() }
})
// DELETE /api/returns/:id (manager) — only an "expected" return created by mistake
// Returns are archived, never deleted (same rule as cases). DELETE is refused here and, after 0018, by the database too.
returnsApi.delete('/:id{[0-9]+}', (c) => c.json({ error: 'Returns are archived, not deleted. Use Archive (manager).' }, 405))
// POST /api/returns/:id/archive | /unarchive (manager) — hides the return from lists and counts; phones, photos and history stay.
returnsApi.post('/:id{[0-9]+}/archive', requireManager, async (c) => {
  const sql = getDb(c.env)
  try { return (await archiveReturn(sql, Number(c.req.param('id')), c.get('user').id, true)) ? c.json({ ok: true }) : c.json({ error: 'Return not found' }, 404) }
  catch (e: any) { return c.json({ error: e.message }, 503) } finally { await sql.end() }
})
returnsApi.post('/:id{[0-9]+}/unarchive', requireManager, async (c) => {
  const sql = getDb(c.env)
  try { return (await archiveReturn(sql, Number(c.req.param('id')), c.get('user').id, false)) ? c.json({ ok: true }) : c.json({ error: 'Return not found' }, 404) }
  catch (e: any) { return c.json({ error: e.message }, 503) } finally { await sql.end() }
})

// ───────── Google Sheet import (manager) ─────────
// POST /api/returns/import {csv, filename, commit:false} → dry run with review list; {commit:true, batch_id} → write
returnsApi.post('/import', requireManager, async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { csv?: string; filename?: string; commit?: boolean; batch_id?: number; sku_overrides?: Record<string, string> }
  const sql = getDb(c.env)
  try {
    const user = c.get('user')
    const known = new Set((await loadSkus(sql)).map((s) => s.sku.toUpperCase()))
    const suppliers = new Set((await loadSuppliers(sql)).filter((s) => s.active).map((s) => s.code))
    const rows = parseCsv(String(b.csv ?? ''))
    if (!rows.length) return c.json({ error: 'No rows found in the CSV' }, 400)
    if (rows.length > 3000) return c.json({ error: 'Import at most 3000 rows at a time' }, 400)
    const overrides = b.sku_overrides ?? {}
    const clean: CleanRow[] = rows.map((r, i) => {
      const cr = cleanRow(r, i + 2, known, suppliers)
      // Manager mapped an unmatched SKU text to a real SKU in the review step
      if (!cr.sku && cr.sku_raw && overrides[cr.sku_raw]) { cr.sku = String(overrides[cr.sku_raw]).toUpperCase(); cr.review = cr.review.filter((x) => x.field !== 'Item details') }
      return cr
    })
    const review = clean.flatMap((r) => r.review)
    const importable = clean.filter((r) => r.order_id)
    const preview = { rows: rows.length, importable: importable.length, unimportable: clean.length - importable.length, review_count: review.length, review,
      sample: importable.slice(0, 8).map((r) => ({ row: r.row, order_id: r.order_id, sku: r.sku ?? `? ${r.sku_raw}`, reason: r.reason, cable: r.cable, outcome: r.outcome, imei: r.imei ? 'ok' : r.review.some((x) => x.field === 'IMEI NO') ? 'review' : '—', return_date: r.return_date })),
      unmatched_skus: [...new Set(clean.filter((r) => !r.sku && r.sku_raw).map((r) => r.sku_raw))] }
    if (!b.commit) {
      const [batch] = await sql`INSERT INTO return_import_batches (filename, mode, row_count, review_count, review, created_by) VALUES (${b.filename ?? null}, 'dry_run', ${rows.length}, ${review.length}, ${sql.json(review)}, ${user.id}) RETURNING id`
      return c.json({ dry_run: true, batch_id: batch.id, ...preview })
    }
    // Commit
    const [batch] = await sql`INSERT INTO return_import_batches (filename, mode, row_count, review_count, review, created_by) VALUES (${b.filename ?? null}, 'committed', ${rows.length}, ${review.length}, ${sql.json(review)}, ${user.id}) RETURNING id`
    let created = 0, updated = 0
    for (const r of importable) {
      const status = r.outcome ? 'closed' : r.return_date ? 'received' : 'expected'
      const [k] = await sql`SELECT id FROM cases WHERE order_id = ${r.order_id} ORDER BY id LIMIT 1`
      // Match by order ID against ANY existing return (Expected from a notice, manual, or a previous import) so the sheet
      // enriches that row instead of creating a second return for the same order.
      const [existing] = await sql`SELECT id FROM returns WHERE order_id = ${r.order_id} ORDER BY (import_batch_id IS NOT NULL) DESC, (status <> 'closed') DESC, id DESC LIMIT 1`
      let id: number
      const flags = r.review.map((x) => `${x.field}: ${x.reason}`)
      if (existing) {
        id = existing.id
        await sql`UPDATE returns SET order_date = COALESCE(order_date, ${r.order_date}), sku = COALESCE(sku, ${r.sku}), marketplace = COALESCE(marketplace, ${r.marketplace}), notes = COALESCE(${r.notes}, notes), received_at = COALESCE(received_at, ${r.return_date ? new Date(r.return_date + 'T12:00:00Z') : null}), review_flags = ${sql.json(flags)}, import_row = ${r.row} WHERE id = ${id}`
        updated++
      } else {
        id = await createReturn(sql, { order_id: r.order_id!, case_id: k?.id ?? null, order_date: r.order_date, marketplace: r.marketplace, sku: r.sku ?? r.sku_raw, quantity: 1, notes: r.notes, status: status === 'expected' ? 'expected' : 'received',
          received_at: r.return_date ? new Date(r.return_date + 'T12:00:00Z') : null, received_by: null, legacy_customer_name: k ? null : r.customer_name, import_batch_id: batch.id, import_row: r.row, review_flags: flags }, user.id)
        created++
      }
      const [item] = await sql`SELECT id FROM return_items WHERE return_id = ${id} ORDER BY item_no LIMIT 1`
      await sql`UPDATE return_items SET imei = COALESCE(${r.imei}, imei), reason_category = COALESCE(${r.reason}, reason_category), cable = COALESCE(${r.cable}, cable), frp_lock = COALESCE(${r.frp}, frp_lock),
                  supplier_code = COALESCE(${r.supplier_code}, supplier_code), outcome = COALESCE(${r.outcome}, outcome), cms_ticket = COALESCE(${r.cms_ticket}, cms_ticket), compensation_ref = COALESCE(${r.compensation_ref}, compensation_ref),
                  replacement_sent_on = COALESCE(${r.replacement_sent_on}, replacement_sent_on),
                  inspected_at = CASE WHEN ${r.reason}::text IS NOT NULL THEN COALESCE(inspected_at, ${r.return_date ? new Date(r.return_date + 'T12:00:00Z') : new Date()}) ELSE inspected_at END,
                  outcome_at = CASE WHEN ${r.outcome}::text IS NOT NULL THEN COALESCE(outcome_at, now()) ELSE outcome_at END
                WHERE id = ${item.id}`
      if (status === 'closed') await sql`UPDATE returns SET status = 'closed', closed_at = COALESCE(closed_at, now()) WHERE id = ${id}`
      else if (status === 'received' && r.reason) await sql`UPDATE returns SET status = 'inspected' WHERE id = ${id} AND status = 'received'`
    }
    await sql`UPDATE return_import_batches SET created_count = ${created}, updated_count = ${updated} WHERE id = ${batch.id}`
    return c.json({ committed: true, batch_id: batch.id, created, updated, ...preview })
  } catch (e) { if (tableMissing(e)) return needMigration(c); throw e } finally { await sql.end() }
})
// POST /api/returns/backfill {commit:false} (manager) — create an Expected return for every Amazon return-authorisation
// notice that has no return on its order yet. Dry run lists the candidates; commit creates them (idempotent: re-running
// finds nothing new). Closed/refunded notices are skipped unless include_closed is set.
returnsApi.post('/backfill', requireManager, async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { commit?: boolean; include_closed?: boolean; days?: number }
  const sql = getDb(c.env)
  try {
    const days = Math.min(Math.max(Number(b.days) || 120, 1), 730)
    const cands = await sql`
      SELECT e.id, e.case_id, e.order_id, e.sku, e.asin, e.quantity, e.return_reason, e.customer_comment, e.received_at, e.status, c.case_ref
      FROM amazon_events e LEFT JOIN cases c ON c.id = e.case_id
      WHERE e.kind = 'return_request' AND e.received_at >= now() - (${days}::int || ' days')::interval
        AND (${!!b.include_closed} OR e.status NOT IN ('refunded','closed'))
        AND NOT EXISTS (SELECT 1 FROM returns r WHERE r.order_id = e.order_id)
      ORDER BY e.received_at DESC`
    const rows = cands.map((e: any) => ({ event_id: e.id, order_id: e.order_id, case_ref: e.case_ref, sku: e.sku, quantity: e.quantity ?? 1, reason: e.return_reason, notice_date: e.received_at, notice_status: e.status }))
    if (!b.commit) return c.json({ dry_run: true, days, candidates: rows.length, rows })
    const user = c.get('user')
    let created = 0; const ids: number[] = []
    for (const e of cands as any[]) {
      const id = await expectedFromNotice(sql, e, user.id)
      if (id) { created++; ids.push(id) }
    }
    return c.json({ committed: true, days, created, return_ids: ids })
  } catch (e) { if (tableMissing(e)) return needMigration(c); throw e } finally { await sql.end() }
})

returnsApi.get('/import/batches', requireManager, async (c) => {
  const sql = getDb(c.env)
  try { return c.json({ batches: await sql`SELECT b.*, u.name AS created_by_name FROM return_import_batches b LEFT JOIN users u ON u.id = b.created_by ORDER BY b.id DESC LIMIT 20` }) }
  catch (e) { if (tableMissing(e)) return needMigration(c); throw e } finally { await sql.end() }
})
