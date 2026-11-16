// Integration check (scratch DB with db/schema.sql; set PGHOST/PGPORT/PGDATABASE or DATABASE_URL):
// resolve-on-send rules and manual merge of duplicate cases.
import postgres from 'postgres'
import { statusAfterSend, mergeCases } from '../src/caseOps'

const sql = process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL) : postgres({ host: process.env.PGHOST, port: Number(process.env.PGPORT), user: 'postgres', database: process.env.PGDATABASE })
let fails = 0
const eq = (name: string, got: unknown, want: unknown) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: got ${JSON.stringify(got)}${ok ? '' : `, want ${JSON.stringify(want)}`}`) }
let n = 0
const mk = async (o: Record<string, unknown> = {}) => {
  const [c] = await sql`INSERT INTO cases (case_ref, subject, status, customer_first_name, customer_email, source, last_customer_message_at, order_id, battery_flag)
    VALUES (${'T-' + ++n}, 'Q', ${(o.status as string) ?? 'open'}, 'Aideen', ${(o.email as string) ?? 'a@marketplace.amazon.co.uk'}, 'gmail', ${(o.at as Date) ?? new Date()}, ${(o.order as string) ?? null}, ${!!o.battery}) RETURNING id, case_ref`
  return c
}
const msg = (caseId: number, dir: string, body: string, at: Date, rfc: string | null = null) =>
  sql`INSERT INTO messages (case_id, direction, sender, body, sent_at, rfc_message_id) VALUES (${caseId}, ${dir}, 'x', ${body}, ${at}, ${rfc}) RETURNING id`
const draft = async (caseId: number) => (await sql`INSERT INTO drafts (case_id, draft_text, original_text, status, model) VALUES (${caseId}, 'hi', 'hi', 'sent', 'm') RETURNING id`)[0].id
const st = async (id: number) => (await sql`SELECT status, archived_at IS NOT NULL AS archived FROM cases WHERE id = ${id}`)[0]
const mgr = { id: 1, name: 'Sagar', role: 'manager' }, agent = { id: 2, name: 'Kuldeep', role: 'agent' }
await sql`INSERT INTO users (id, email, name, role, password_hash) VALUES (1,'m@x','Sagar','manager','x'),(2,'a@x','Kuldeep','agent','x') ON CONFLICT DO NOTHING`

// ── resolve on send
{ const c = await mk(); eq('send, dot off → awaiting_customer', (await statusAfterSend(sql, c.id, false, await draft(c.id))).status, 'awaiting_customer'); eq('  db', (await st(c.id)).status, 'awaiting_customer') }
{ const c = await mk(); eq('send, dot on → resolved', (await statusAfterSend(sql, c.id, true, await draft(c.id))).status, 'resolved'); eq('  db', (await st(c.id)).status, 'resolved') }
{ const c = await mk({ battery: true }); const r = await statusAfterSend(sql, c.id, true, await draft(c.id)); eq('battery flag keeps it open', [r.status, r.blocked], ['awaiting_customer', ['battery/heat flag']]) }
{ const c = await mk({ order: '111-1111111-1111111' })
  await sql`INSERT INTO amazon_events (case_id, order_id, kind, status, received_at) VALUES (${c.id}, '111-1111111-1111111', 'atoz_claim', 'open', now())`
  const r = await statusAfterSend(sql, c.id, true, await draft(c.id)); eq('open A-to-Z keeps it open', r.blocked, ['open A-to-Z claim']) }

// ── merge: the RIQ-1330 / RIQ-1331 shape
{ const t = new Date(Date.now() - 86400000)
  const a = await mk({ status: 'awaiting_customer', at: t }), b = await mk({ at: t })
  await msg(a.id, 'inbound', 'Can you send me a battery health check summary', t)
  await msg(a.id, 'outbound', 'Dear Aideen, ...', new Date())
  await msg(b.id, 'inbound', 'Can you send me a battery health check summary', new Date(t.getTime() + 14000))
  const r: any = await mergeCases(sql, a.id, [b.id], agent)
  eq('agent can merge same customer', r.ok, true)
  eq('duplicate message shown once', r.duplicates_removed, 1)
  const ms = await sql`SELECT direction, kind FROM messages WHERE case_id = ${a.id} ORDER BY sent_at, id`
  eq('kept case thread', ms.map((m: any) => `${m.direction}/${m.kind}`), ['inbound/message', 'outbound/message', 'inbound/event'])
  eq('kept case stays awaiting (we replied last)', (await st(a.id)).status, 'awaiting_customer')
  eq('other case archived', (await st(b.id)).archived, true)
  eq('nothing left on other case', (await sql`SELECT count(*)::int AS n FROM messages WHERE case_id = ${b.id}`)[0].n, 0) }

// customer wrote again on the duplicate → kept case reopens
{ const t = new Date(Date.now() - 86400000)
  const a = await mk({ status: 'awaiting_customer', at: t }), b = await mk({ at: new Date() })
  await msg(a.id, 'inbound', 'q1', t); await msg(a.id, 'outbound', 'answer', new Date(t.getTime() + 1000)); await msg(b.id, 'inbound', 'one more thing', new Date())
  const r: any = await mergeCases(sql, a.id, [b.id], agent)
  eq('customer spoke last → reopened', [r.status, (await st(a.id)).status], ['open', 'open']) }

// guards
{ const a = await mk({ order: '111-0000000-0000001' }), b = await mk({ order: '111-0000000-0000002' })
  const r: any = await mergeCases(sql, a.id, [b.id], mgr); eq('different orders refused', [r.ok, r.status], [false, 409]) }
{ const a = await mk({ email: 'p@x' }), b = await mk({ email: 'q@x' })
  const r: any = await mergeCases(sql, a.id, [b.id], agent); eq('agent, different customers refused', [r.ok, r.status], [false, 403])
  const m: any = await mergeCases(sql, a.id, [b.id], mgr); eq('manager, different customers allowed', m.ok, true) }
{ const a = await mk(); const r: any = await mergeCases(sql, a.id, [a.id], agent); eq('needs two cases', [r.ok, r.status], [false, 400]) }

await sql.end()
if (fails) { console.log(`${fails} failed`); process.exit(1) }
