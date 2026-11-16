// Invoice generator (moved in from the stand-alone Amazon Invoice Dashboard, migration 0023).
//   GET    /api/invoices                 history (?q= order ID / invoice number / buyer)
//   GET    /api/invoices/settings        branding, margin-scheme note, T&Cs
//   PUT    /api/invoices/settings        manager only
//   GET    /api/invoices/prefill?case_id what ReplyIQ already knows about the case's order (Amazon order + customer)
//   GET    /api/invoices/by-order/:id    existing invoices for an Amazon order (to stop duplicates)
//   GET    /api/invoices/:id             full record, for re-download
//   POST   /api/invoices                 save; invoice_number = the Zoho Inventory number (required, unique)
//   DELETE /api/invoices/:id             manager only
// The PDF itself is drawn in the browser (jsPDF), as before. Nothing here is ever sent to OpenAI.
import { Hono } from 'hono'
import { getDb, type Bindings } from '../db'
import { requireManager, type Vars } from '../auth'
import { fetchOrder, fetchOrderContact, spapiConfigured, type SpapiEnv } from '../spapi'

export const invoicesApi = new Hono<{ Bindings: Bindings; Variables: Vars }>()
const MIGRATION = 'db/migrations/0023_invoices.sql'
const notMigrated = (e: any) => /relation "invoice(s|_settings)" does not exist/i.test(String(e?.message))
const fail = (c: any, e: any) => notMigrated(e) ? c.json({ error: `Invoices are not set up yet: run ${MIGRATION} in Supabase.`, migration: MIGRATION }, 503) : c.json({ error: e.message }, 500)

const SETTINGS_FIELDS = ['company_name', 'address_line1', 'address_line2', 'city', 'postcode', 'country', 'vat_number', 'company_number', 'email', 'phone',
  'logo_data_url', 'accent_color', 'margin_scheme_enabled', 'margin_scheme_note', 'footer_note', 'terms_and_conditions'] as const
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0 }
const str = (v: unknown, max = 2000) => String(v ?? '').slice(0, max)

invoicesApi.get('/', async (c) => {
  const q = str(c.req.query('q'), 100).trim()
  const sql = getDb(c.env)
  try {
    const like = `%${q}%`
    const rows = await sql`
      SELECT i.id, i.invoice_number, i.order_id, i.buyer_name, i.invoice_date, i.currency, i.total, i.case_id, i.created_at,
             u.name AS created_by_name, k.case_ref
      FROM invoices i LEFT JOIN users u ON u.id = i.created_by LEFT JOIN cases k ON k.id = i.case_id
      WHERE ${q ? sql`(i.invoice_number ILIKE ${like} OR i.order_id ILIKE ${like} OR i.buyer_name ILIKE ${like})` : sql`TRUE`}
      ORDER BY i.id DESC LIMIT 200`
    return c.json({ invoices: rows })
  } catch (e) { return fail(c, e) } finally { await sql.end() }
})

invoicesApi.get('/settings', async (c) => {
  const sql = getDb(c.env)
  try { const [s] = await sql`SELECT * FROM invoice_settings WHERE id = 1`; return c.json({ settings: s ?? null }) }
  catch (e) { return fail(c, e) } finally { await sql.end() }
})

invoicesApi.put('/settings', requireManager, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const patch: Record<string, unknown> = {}
  for (const k of SETTINGS_FIELDS) if (k in body) patch[k] = k === 'margin_scheme_enabled' ? !!body[k] : str(body[k], k === 'logo_data_url' ? 1_500_000 : 4000)
  if (patch.logo_data_url && !/^data:image\/(png|jpe?g);base64,/.test(String(patch.logo_data_url))) return c.json({ error: 'The logo must be a PNG or JPG image' }, 400)
  if (patch.accent_color && !/^#[0-9a-f]{6}$/i.test(String(patch.accent_color))) return c.json({ error: 'Accent colour must look like #1a2b3c' }, 400)
  const sql = getDb(c.env)
  try {
    const keys = Object.keys(patch)
    if (keys.length) await sql`UPDATE invoice_settings SET ${sql(patch, keys)}, updated_by = ${c.get('user').id}, updated_at = now() WHERE id = 1`
    const [s] = await sql`SELECT * FROM invoice_settings WHERE id = 1`
    return c.json({ settings: s })
  } catch (e) { return fail(c, e) } finally { await sql.end() }
})

// What ReplyIQ already knows: the case's order (cached Amazon order: items, prices, dates) and the customer's name/address.
invoicesApi.get('/prefill', async (c) => {
  const caseId = Number(c.req.query('case_id'))
  if (!Number.isInteger(caseId)) return c.json({ error: 'case_id required' }, 400)
  const sql = getDb(c.env)
  try {
    const [k] = await sql`SELECT id, case_ref, order_id, customer_first_name, customer_last_name, customer_address FROM cases WHERE id = ${caseId}`
    if (!k) return c.json({ error: 'Case not found' }, 404)
    const env = c.env as SpapiEnv
    const live = !!k.order_id && spapiConfigured(env)
    // Order (items, prices, dates): the cached copy, or fetch it now if the case was never fetched.
    let [o] = k.order_id ? await sql`SELECT payload FROM amazon_orders WHERE order_id = ${k.order_id}`.catch(() => []) : []
    if (!o && live) {
      try {
        const summary = await fetchOrder(env, k.order_id)
        await sql`INSERT INTO amazon_orders (order_id, payload, fetched_at) VALUES (${k.order_id}, ${sql.json(summary as any)}, now())
                  ON CONFLICT (order_id) DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now()`
        o = { payload: summary }
      } catch { /* fall back to paste */ }
    }
    // Name + delivery address straight from Amazon (not stored anywhere except on the invoice the user saves).
    let contact: { name: string; buyerName: string; addressLines: string[]; fields: string[] } | null = null, contactError = ''
    if (live) {
      try { contact = await fetchOrderContact(env, k.order_id) } catch (e: any) {
        contactError = e?.status === 403 ? 'Amazon refused the buyer name and address: the ReplyIQ app needs the personal-data (PII) role in Seller Central (Apps & Services > Develop apps). Paste the Order details page instead.' : `Amazon did not return the address (${e?.message || 'error'}). Paste the Order details page instead.`
      }
      // Without the restricted address role Amazon sends only town, county and postcode (no street, no recipient name).
      if (contact && contact.addressLines.length && !contact.fields.some((f) => /^addressLine1:text/.test(f)) && !contactError)
        contactError = 'Amazon only gave the town, county and postcode, not the street (the ReplyIQ app needs Amazon\'s Tax Invoicing or Direct-to-Consumer Shipping role for that). Paste the Order details page below to fill in the full address.'
      if (contact && !contact.addressLines.length && !contactError) contactError = 'Amazon returned no address for this order (the app may be missing the personal-data role). Paste the Order details page instead.'
    }
    const existing = k.order_id ? await sql`SELECT id, invoice_number, created_at FROM invoices WHERE order_id = ${k.order_id} ORDER BY id DESC` : []
    const p: any = o?.payload ?? null
    const amazonName = contact?.name || contact?.buyerName || ''
    return c.json({
      case: { id: k.id, case_ref: k.case_ref },
      order_id: k.order_id ?? '',
      buyer_name: amazonName || [k.customer_first_name, k.customer_last_name].filter(Boolean).join(' '),
      buyer_address: contact?.addressLines.length ? contact.addressLines.join('\n') : k.customer_address ?? '',
      contact_source: contact?.addressLines.length ? 'amazon' : 'case',
      contact_error: contactError,
      address_fields: contact?.fields ?? [],
      order: p ? { orderDate: p.orderDate, shipDate: p.shipDate, currency: p.currency, grandTotal: p.grandTotal, items: p.items ?? [] } : null,
      existing,
    })
  } catch (e) { return fail(c, e) } finally { await sql.end() }
})

invoicesApi.get('/by-order/:orderId', async (c) => {
  const sql = getDb(c.env)
  try { return c.json({ invoices: await sql`SELECT id, invoice_number, created_at FROM invoices WHERE order_id = ${c.req.param('orderId')} ORDER BY id DESC` }) }
  catch (e) { return fail(c, e) } finally { await sql.end() }
})

invoicesApi.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'Not found' }, 404)
  const sql = getDb(c.env)
  try {
    const [r] = await sql`SELECT i.*, u.name AS created_by_name FROM invoices i LEFT JOIN users u ON u.id = i.created_by WHERE i.id = ${id}`
    return r ? c.json({ invoice: r }) : c.json({ error: 'Not found' }, 404)
  } catch (e) { return fail(c, e) } finally { await sql.end() }
})

invoicesApi.post('/', async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, any>
  const invoiceNumber = str(b.invoice_number, 60).trim()
  if (!invoiceNumber) return c.json({ error: 'Enter the invoice number from Zoho Inventory' }, 400)
  const items = (Array.isArray(b.items) ? b.items : []).slice(0, 50).map((it: any) => ({
    name: str(it.name, 300), asin: str(it.asin, 20), sku: str(it.sku, 80), condition: str(it.condition, 60), imei: str(it.imei, 40),
    quantity: Math.max(0, Math.round(Number(it.quantity) || 0)), unitPrice: num(it.unitPrice), total: num(it.total),
  }))
  if (!items.length || !items.some((it: any) => it.name)) return c.json({ error: 'Add at least one item' }, 400)
  const caseId = Number.isInteger(Number(b.case_id)) && Number(b.case_id) > 0 ? Number(b.case_id) : null
  const sql = getDb(c.env)
  try {
    const [settings] = await sql`SELECT * FROM invoice_settings WHERE id = 1`
    if (!settings) return c.json({ error: 'Invoice settings are missing' }, 400)
    const { updated_by, updated_at, ...snapshot } = settings as any
    const [row] = await sql`
      INSERT INTO invoices (invoice_number, order_id, seller_order_id, purchase_date, ship_date, invoice_date, sales_channel, buyer_name, buyer_address,
        currency, items, shipping, subtotal, total, notes, margin_scheme_enabled, settings_snapshot, raw_paste, case_id, created_by)
      VALUES (${invoiceNumber}, ${str(b.order_id, 40).trim()}, ${str(b.seller_order_id, 60)}, ${str(b.purchase_date, 60)}, ${str(b.ship_date, 60)},
        ${str(b.invoice_date, 60)}, ${str(b.sales_channel, 60)}, ${str(b.buyer_name, 200)}, ${str(b.buyer_address, 1000)}, ${str(b.currency, 3) || 'GBP'},
        ${sql.json(items)}, ${num(b.shipping)}, ${num(b.subtotal)}, ${num(b.total)}, ${str(b.notes, 2000)}, ${b.margin_scheme_enabled !== false},
        ${sql.json(snapshot)}, ${str(b.raw_paste, 30000)}, ${caseId}, ${c.get('user').id})
      ON CONFLICT (invoice_number) DO NOTHING
      RETURNING *`
    if (!row) return c.json({ error: `Invoice number "${invoiceNumber}" is already used. Check the number in Zoho Inventory.` }, 409)
    if (caseId) await sql`INSERT INTO messages (case_id, direction, sender, body, kind, sent_at)
      VALUES (${caseId}, 'inbound', 'ReplyIQ', ${`Invoice ${invoiceNumber} generated by ${c.get('user').name}.`}, 'event', now())`.catch(() => {})
    return c.json({ invoice: row })
  } catch (e) { return fail(c, e) } finally { await sql.end() }
})

invoicesApi.delete('/:id', requireManager, async (c) => {
  const sql = getDb(c.env)
  try { await sql`DELETE FROM invoices WHERE id = ${Number(c.req.param('id'))}`; return c.json({ ok: true }) }
  catch (e) { return fail(c, e) } finally { await sql.end() }
})
