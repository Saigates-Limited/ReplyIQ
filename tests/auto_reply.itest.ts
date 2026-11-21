// Integration (scratch DB, OpenAI and Gmail stubbed): closed-day replies end to end.
import { register } from 'node:module'
register('data:text/javascript,' + encodeURIComponent(`
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
export async function resolve(spec, ctx, next) { if (spec.endsWith('?raw')) return { url: new URL(spec, ctx.parentURL).href + '?raw', shortCircuit: true }; return next(spec, ctx) }
export async function load(url, ctx, next) { if (url.endsWith('?raw')) return { format: 'module', source: 'export default ' + JSON.stringify(readFileSync(fileURLToPath(url.slice(0, -4)), 'utf8')), shortCircuit: true }; return next(url, ctx) }`))
const postgres = (await import('postgres')).default
const { runAutoReplies, saveAutoReplySettings } = await import('../src/autoReply')
const { encryptToken } = await import('../src/gmail')
const sql = postgres(process.env.DATABASE_URL!, { prepare: false, fetch_types: false })
let fails = 0
const eq = (n: string, got: unknown, want: unknown) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${n}: ${JSON.stringify(got)?.slice(0, 160)}${ok ? '' : ` want ${JSON.stringify(want)}`}`) }

const env: any = { OPENAI_API_KEY: 'test', GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'y', TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString('base64') }
const sentMail: string[] = []
let holdingMode: 'good' | 'bad' = 'good'
const realFetch = globalThis.fetch
globalThis.fetch = (async (url: any, init: any) => {
  const u = String(url)
  if (u.includes('oauth2.googleapis.com')) return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }))
  if (u.includes('gmail.googleapis.com') && u.includes('/messages/send')) { sentMail.push(JSON.parse(init.body).raw); return new Response(JSON.stringify({ id: 'g' + Date.now() + '-' + sentMail.length, threadId: 't1' })) }
  if (u.includes('/chat/completions')) {
    const b = JSON.parse(init.body); const sys = b.messages[0].content as string; const user = b.messages[1].content as string
    if (sys.startsWith('You write one short email')) {
      const reply = holdingMode === 'good'
        ? 'Dear Priya,\n\nThank you for your message about your iPhone 12 and the battery getting hot. We understand how worrying that is. Please stop using and charging the phone for now. A member of our team will reply with a full answer by Monday 23 November.\n\nOur returns team remains available over the weekend and on bank holidays.\n\nKind regards,\nCustomer Support Team'
        : 'Dear Priya,\n\nWe will refund you in full today.\n\nKind regards,\nCustomer Support Team'
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply }) } }] }))
    }
    if (sys.startsWith('You check')) return new Response(JSON.stringify({ choices: [{ message: { content: '{"verdicts":[]}' } }] }))
    const hot = /battery.*hot|hot.*battery/i.test(user)
    const out = hot
      ? { lane: 'safety', reply: 'Dear Priya,\n\nPlease stop using the phone. We will arrange a return.\n\nKind regards,\nCustomer Support Team', staff_notes: 'battery', needs_manager: true, urgency: 'high' }
      : { lane: 'delivery', reply: 'Dear Tom,\n\nThank you for your message. Your iPhone 13 was dispatched on Friday with Royal Mail Tracked 24 and should arrive on Monday.\n\nKind regards,\nCustomer Support Team', staff_notes: '', needs_manager: false, urgency: 'normal' }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }] }))
  }
  return realFetch(url, init)
}) as any

// Setup: Amazon mailbox, settings ON, two waiting buyer messages from Saturday morning, one answered case, one non-Amazon case.
const SAT = new Date('2026-11-21T12:00:00Z')
await sql`UPDATE cases SET archived_at = now() WHERE case_ref LIKE 'T-AR-%' AND archived_at IS NULL` // earlier runs
await sql`DELETE FROM gmail_connection`
await sql`INSERT INTO gmail_connection (id, email_address, refresh_token_enc, scopes, enabled, is_default) VALUES (1, 'bijalshah.cc@gmail.com', ${await encryptToken(env, 'rt')}, 'gmail', true, true)`
await sql`DELETE FROM app_settings WHERE key IN ('auto_reply','bank_holidays')`
await sql`INSERT INTO app_settings (key, value, updated_at) VALUES ('bank_holidays', ${sql.json({ '2026-12-25': 'Christmas Day' })}, now())`
const [mgr] = await sql`SELECT id FROM users ORDER BY id LIMIT 1`
const mk = async (ref: string, first: string, replyTo: string, body: string, at: Date, extra: { outbound?: Date } = {}) => {
  const [k] = await sql`INSERT INTO cases (case_ref, subject, status, customer_first_name, source, customer_reply_to, gmail_thread_id, device_model, last_customer_message_at)
    VALUES (${ref + Date.now()}, 'Order question', 'open', ${first}, 'gmail', ${replyTo}, ${'thr' + ref + Date.now()}, 'iPhone 13 128GB', ${at}) RETURNING id`
  await sql`INSERT INTO messages (case_id, direction, sender, body, subject, sent_at, kind, rfc_message_id) VALUES (${k.id}, 'inbound', ${first}, ${body}, 'Order question', ${at}, 'message', ${'<m' + k.id + '@x>'})`
  if (extra.outbound) await sql`INSERT INTO messages (case_id, direction, sender, body, sent_at) VALUES (${k.id}, 'outbound', 'Saigates Support (Kuldeep)', 'Answered', ${extra.outbound})`
  return k.id
}
const routine = await mk('T-AR-A', 'Tom', 'tom123@marketplace.amazon.co.uk', 'Hi, when will my iPhone 13 arrive?', new Date('2026-11-21T09:00:00Z'))
const high = await mk('T-AR-B', 'Priya', 'priya9@marketplace.amazon.co.uk', 'My battery is getting very hot when charging, I want a refund now.', new Date('2026-11-21T10:00:00Z'))
const answered = await mk('T-AR-C', 'Sam', 'sam1@marketplace.amazon.co.uk', 'Where is my order?', new Date('2026-11-21T08:00:00Z'), { outbound: new Date('2026-11-21T08:30:00Z') })
const notAmazon = await mk('T-AR-D', 'Royal', 'claims@royalmail.com', 'Your claim update', new Date('2026-11-21T09:30:00Z'))
const thursday = await mk('T-AR-E', 'Old', 'old1@marketplace.amazon.co.uk', 'Question from Thursday', new Date('2026-11-19T10:00:00Z'))
const tooFresh = await mk('T-AR-F', 'Tom', 'fresh1@marketplace.amazon.co.uk', 'Just now', new Date('2026-11-21T11:55:00Z'))

// The MIME message is base64url; inside it the text part is base64 again. Return headers + decoded plain text.
const dec = (raw: string) => {
  const mime = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
  const part = mime.split(/Content-Type: text\/plain[^\n]*\n(?:[^\n]*\n)*?\r?\n/)[1]?.split(/\r?\n--/)[0] ?? ''
  return mime.split(/\r?\n\r?\n/)[0] + '\n' + Buffer.from(part.replace(/\s+/g, ''), 'base64').toString('utf8')
}
// 1. Off: nothing happens.
eq('off: no outcomes', (await runAutoReplies(env, sql, { now: SAT })).outcomes.length, 0)
// 2. Preview while off: writes, sends nothing.
const pv = await runAutoReplies(env, sql, { now: SAT, dryRun: true })
const mine = (o: any[]) => o.filter((x) => [routine, high, answered, notAmazon, thursday, tooFresh].includes(x.case_id))
eq('preview: Tom full now, Priya holding scheduled', mine(pv.outcomes).map((o) => [o.case_id === routine ? 'routine' : 'high', o.kind]), [['routine', 'full'], ['high', 'scheduled']])
eq('preview: Priya scheduled for Sunday 16:45 (as late as possible inside 48h)', mine(pv.outcomes).find((o) => o.case_id === high)?.send_at, '2026-11-22T16:45:00.000Z')
eq('preview sent nothing', sentMail.length, 0)
await saveAutoReplySettings(sql, { enabled: true }, mgr.id)
// 3. Outside 9-5 nothing goes out, even when switched on.
eq('Saturday 07:30: outside 9-5, nothing', (await runAutoReplies(env, sql, { now: new Date('2026-11-21T07:30:00Z') })).outcomes.length, 0)
// 4. On, Saturday 12:00: routine sent; high stakes scheduled, full draft held.
const r1 = await runAutoReplies(env, sql, { now: SAT })
eq('Saturday: full sent, holding scheduled', mine(r1.outcomes).map((o) => o.kind), ['full', 'scheduled'])
eq('one email sent', sentMail.length, 1)
eq('full reply went to Tom', /To: tom123@marketplace.amazon.co.uk/.test(dec(sentMail[0])) && /dispatched on Friday/.test(dec(sentMail[0])), true)
const [ks] = await sql`SELECT status FROM cases WHERE id = ${routine}`
eq('routine case now awaiting customer', ks.status, 'awaiting_customer')
eq('high case: full draft held for staff', (await sql`SELECT auto_reply, status FROM drafts WHERE case_id = ${high} ORDER BY id`).map((d: any) => [d.auto_reply, d.status]), [['held', 'draft']])
// 5. Saturday 12:15: the message that was under 10 minutes old is now answered; nothing else.
const r2 = mine((await runAutoReplies(env, sql, { now: new Date('2026-11-21T12:15:00Z') })).outcomes)
eq('Saturday 12:15: only the newer message', r2.map((o) => [o.case_id === tooFresh, o.kind]), [[true, 'full']])
// 6. Sunday 16:30: not yet. Sunday 16:45: the holding reply goes.
eq('Sunday 16:30: holding not due yet', mine((await runAutoReplies(env, sql, { now: new Date('2026-11-22T16:30:00Z') })).outcomes).length, 0)
const r3 = mine((await runAutoReplies(env, sql, { now: new Date('2026-11-22T16:45:00Z') })).outcomes)
eq('Sunday 16:45: holding reply sent', r3.map((o) => o.kind), ['holding'])
const hold = dec(sentMail[sentMail.length - 1])
eq('holding reply: returns sentence, no decision, never says automatic', /returns team remains available/.test(hold) && !/refund you/i.test(hold) && !/automat|out of office/i.test(hold), true)
const [hm] = await sql`SELECT sender FROM messages WHERE case_id = ${high} AND direction = 'outbound'`
eq('timeline label (internal)', hm.sender, 'Saigates Support (closed-day reply)')
eq('nothing sent twice', mine((await runAutoReplies(env, sql, { now: new Date('2026-11-22T16:59:00Z') })).outcomes).length, 0)
// 7. Customer writes again Sunday 16:40: deadline Tue 16:40, staff back Mon 09:00, so left for staff, no second reply.
await sql`INSERT INTO messages (case_id, direction, sender, body, sent_at, kind) VALUES (${high}, 'inbound', 'Priya', 'Hello? It is still hot.', '2026-11-22T16:40:00Z', 'message')`
const n = sentMail.length
const r4 = mine((await runAutoReplies(env, sql, { now: new Date('2026-11-22T16:55:00Z') })).outcomes)
eq('Sunday follow-up: left for staff (back Monday before the deadline)', r4.map((o) => o.kind), ['staff'])
eq('no new email', sentMail.length, n)
// 8. A scheduled holding reply is dropped if someone replies first.
const early = await mk('T-AR-H', 'Kim', 'kim2@marketplace.amazon.co.uk', 'My battery is getting very hot, I want a refund', new Date('2026-11-21T11:00:00Z'))
await runAutoReplies(env, sql, { now: new Date('2026-11-21T12:30:00Z') })
await sql`INSERT INTO messages (case_id, direction, sender, body, sent_at) VALUES (${early}, 'outbound', 'Saigates Support (Kuldeep)', 'We are on it', '2026-11-21T13:00:00Z')`
const r5 = (await runAutoReplies(env, sql, { now: new Date('2026-11-22T16:45:00Z') })).outcomes.filter((o) => o.case_id === early)
eq('staff replied first: scheduled holding reply not sent', r5.map((o) => [o.kind, o.detail]), [['superseded', 'not sent: someone already replied']])
// 9. A model holding reply that decides something is replaced by the standard wording (Christmas).
holdingMode = 'bad'
const bad = await mk('T-AR-G', 'Lee', 'lee7@marketplace.amazon.co.uk', 'My battery is getting very hot, refund me', new Date('2026-12-24T18:00:00Z'))
await runAutoReplies(env, sql, { now: new Date('2026-12-25T09:15:00Z') })
const r6 = (await runAutoReplies(env, sql, { now: new Date('2026-12-26T16:45:00Z') })).outcomes.find((o) => o.case_id === bad)!
eq('bad model wording: standard holding wording', r6?.kind === 'holding' && /standard wording/.test(r6.detail) && /Dear Lee/.test(r6.text!) && !/refund you/i.test(r6.text!), true)
// 10. Monday: open, nothing sent.
eq('Monday: open', (await runAutoReplies(env, sql, { now: new Date('2026-11-23T10:00:00Z') })).closed, false)
await sql`DELETE FROM gmail_connection`
await sql.end()
if (fails) { console.log(`${fails} failed`); process.exit(1) } else console.log('all passed')
