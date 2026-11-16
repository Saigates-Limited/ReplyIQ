// Integration check (needs DATABASE_URL to a scratch DB with db/schema.sql): same email in two mailboxes -> one case.
import postgres from 'postgres'
import { register } from 'node:module'
register('data:text/javascript,' + encodeURIComponent(`
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
export async function resolve(spec, ctx, next) {
  if (spec.endsWith('?raw')) return { url: new URL(spec, ctx.parentURL).href + '?raw', shortCircuit: true }
  return next(spec, ctx)
}
export async function load(url, ctx, next) {
  if (url.endsWith('?raw')) return { format: 'module', source: 'export default ' + JSON.stringify(readFileSync(fileURLToPath(url.slice(0, -4)), 'utf8')), shortCircuit: true }
  return next(url, ctx)
}`))
const { caseOfSameEmail } = await import('../src/sync')
const sql = process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL) : postgres({ host: process.env.PGHOST, port: Number(process.env.PGPORT), user: 'postgres', database: process.env.PGDATABASE })
const amazonBody = (t: string) => ({ mimeType: 'text/plain', body: { data: Buffer.from(`------------- Message: -------------\n\n${t}\n\n------------- End message -------------`).toString('base64url') } })
const msg = (id: string, rfc: string | null, t: string, at: number): any => ({ id, internalDate: String(at), payload: { headers: [{ name: 'From', value: 'Aideen <x@marketplace.amazon.co.uk>' }, ...(rfc ? [{ name: 'Message-ID', value: rfc }] : [])], ...amazonBody(t) } })
const at = Date.parse('2026-11-14T15:23:19Z')
const [c] = await sql`INSERT INTO cases (case_ref, subject, status, customer_first_name, customer_email, customer_reply_to, source, last_customer_message_at, gmail_thread_id)
  VALUES ('RIQ-T1','Product details enquiry','open','Aideen','x@marketplace.amazon.co.uk','x@marketplace.amazon.co.uk','gmail',now(),'threadA') RETURNING id`
const { parseAmazonBody } = await import('../src/sync')
const text = parseAmazonBody(Buffer.from(amazonBody('Can you send me a battery health check summary').body.data, 'base64url').toString()).text
await sql`INSERT INTO messages (case_id, direction, sender, body, gmail_message_id, rfc_message_id, sent_at) VALUES (${c.id},'inbound','Customer',${text},'gA',null,${new Date(at)})`
const r = (n: string, v: any, e: any) => console.log(`${v === e ? 'ok  ' : 'FAIL'} ${n}: got ${v}, want ${e}`)
r('same text, other mailbox, no Message-ID', await caseOfSameEmail(sql, [msg('gB', null, 'Can you send me a battery health check summary', at + 5000)], 'x@marketplace.amazon.co.uk'), c.id)
r('different customer', await caseOfSameEmail(sql, [msg('gC', null, 'Can you send me a battery health check summary', at)], 'y@marketplace.amazon.co.uk'), null)
r('same customer, text 10 min later', await caseOfSameEmail(sql, [msg('gD', null, 'Can you send me a battery health check summary', at + 600000)], 'x@marketplace.amazon.co.uk'), null)
await sql`UPDATE messages SET rfc_message_id = '<abc@amazon>' WHERE gmail_message_id = 'gA'`
r('same Message-ID', await caseOfSameEmail(sql, [msg('gE', '<abc@amazon>', 'different text', at + 999999)], 'z@x'), c.id)
await sql.end()
