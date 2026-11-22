// Integration (scratch DB): the 30-day buyer-data clean-up.
import { register } from 'node:module'
register('data:text/javascript,' + encodeURIComponent(`
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
export async function resolve(spec, ctx, next) { if (spec.endsWith('?raw')) return { url: new URL(spec, ctx.parentURL).href + '?raw', shortCircuit: true }; return next(spec, ctx) }
export async function load(url, ctx, next) { if (url.endsWith('?raw')) return { format: 'module', source: 'export default ' + JSON.stringify(readFileSync(fileURLToPath(url.slice(0, -4)), 'utf8')), shortCircuit: true }; return next(url, ctx) }`))
const postgres = (await import('postgres')).default
const { purgeBuyerData } = await import('../src/security')
const { redactPii } = await import('../src/ai')
const sql = postgres(process.env.DATABASE_URL!, { prepare: false, fetch_types: false })
let fails = 0
const eq = (n: string, got: unknown, want: unknown) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${n}: ${JSON.stringify(got)}${ok ? '' : ` want ${JSON.stringify(want)}`}`) }
const pat = (t: string) => redactPii(t, { customer_first_name: '' } as any)
const old = new Date(Date.now() - 40 * 86400_000), recent = new Date(Date.now() - 5 * 86400_000)
const mk = async (ref: string, status: string, last: Date, extra: any = {}) => {
  const [k] = await sql`INSERT INTO cases (case_ref, subject, status, customer_first_name, customer_last_name, customer_email, customer_address, source, last_customer_message_at, a_to_z_open, internal_notes)
    VALUES (${ref + Date.now()}, 'Battery', ${status}, 'Ivan', 'Petrov', 'ivan.p@example.com', '12 Mill Lane, Bilston, WV14 0AB', 'gmail', ${last}, ${extra.atoz ?? false}, 'Ivan Petrov rang twice') RETURNING id`
  await sql`INSERT INTO messages (case_id, direction, sender, body, sent_at) VALUES (${k.id}, 'inbound', 'Customer', ${'Hi, Ivan Petrov here. Ship to 12 Mill Lane, Bilston WV14 0AB please. My number is 07700 900123. Order 202-1234567-1234567, IMEI 356789012345678.'}, ${last})`
  await sql`INSERT INTO drafts (case_id, draft_text, original_text, status) VALUES (${k.id}, 'Dear Ivan,\nThanks.', 'Dear Ivan,\nThanks.', 'sent')`
  return k.id
}
const due = await mk('T-PG-A', 'resolved', old)
const open = await mk('T-PG-B', 'open', old)
const fresh = await mk('T-PG-C', 'resolved', recent)
const atoz = await mk('T-PG-D', 'resolved', old, { atoz: true })
const shipped = await mk('T-PG-E', 'open', new Date(Date.now() - 95 * 86400_000)) // last contact 95 days ago
const writing = await mk('T-PG-F', 'open', recent) // shipped long ago but wrote 5 days ago: kept
const oid = '202-' + String(Date.now()).slice(-7) + '-0000001'
await sql`UPDATE cases SET order_id = ${oid} WHERE id = ${shipped}`
await sql`INSERT INTO amazon_orders (order_id, payload) VALUES (${oid}, ${sql.json({ shipDate: new Date(Date.now() - 100 * 86400_000).toISOString() } as any)})`
const oid2 = '202-' + String(Date.now()).slice(-7) + '-0000002'
await sql`UPDATE cases SET order_id = ${oid2} WHERE id = ${writing}`
await sql`INSERT INTO amazon_orders (order_id, payload) VALUES (${oid2}, ${sql.json({ shipDate: new Date(Date.now() - 100 * 86400_000).toISOString() } as any)})`
const r = await purgeBuyerData(sql, pat)
eq('open case 100 days after shipping and contact is cleaned too', r.ids.includes(shipped), true)
eq('customer still writing (5 days ago) is kept even 100 days after shipping', r.ids.includes(writing), false)
eq('only the closed, quiet case is cleaned', r.ids.filter((i) => [due, open, fresh, atoz].includes(i)), [due])
const [c] = await sql`SELECT customer_first_name, customer_last_name, customer_email, customer_address, internal_notes, pii_purged_at IS NOT NULL AS done FROM cases WHERE id = ${due}`
eq('case fields blanked', [c.customer_first_name, c.customer_last_name, c.customer_email, c.customer_address, c.done], ['Customer', null, null, null, true])
eq('notes scrubbed', c.internal_notes, '[removed] rang twice')
const [m] = await sql`SELECT body FROM messages WHERE case_id = ${due}`
eq('message has no PII', /Ivan|Petrov|Mill Lane|Bilston|WV14|900123/.test(m.body), false)
eq('order id + IMEI kept', /202-1234567-1234567/.test(m.body) && /356789012345678/.test(m.body), true)
const [d] = await sql`SELECT draft_text FROM drafts WHERE case_id = ${due}`
eq('draft greeting scrubbed', d.draft_text, 'Dear [removed],\nThanks.')
const [o] = await sql`SELECT customer_last_name FROM cases WHERE id = ${open}`
eq('open case untouched', o.customer_last_name, 'Petrov')
const again = await purgeBuyerData(sql, pat)
eq('second run does nothing new', again.ids.includes(due), false)
const [log] = await sql`SELECT detail FROM security_log WHERE event = 'pii_purge' ORDER BY id DESC LIMIT 1`
const det = typeof log.detail === 'string' ? JSON.parse(log.detail) : log.detail
eq('logged', det.case_ids.includes(due), true)
let blocked = false; try { await sql`DELETE FROM security_log` } catch { blocked = true }
eq('security log cannot be deleted', blocked, true)
await sql.end()
if (fails) { console.log(`${fails} failed`); process.exit(1) } else console.log('all passed')
