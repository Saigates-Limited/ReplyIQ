// Integration (scratch DB): the RIQ-1300 sequence.
import postgres from 'postgres'
import { markDraftsSentFromCopy, findAlreadySent, customerWroteSince } from '../src/sendGuards'
const sql = postgres(process.env.DATABASE_URL!, { prepare: false, fetch_types: false })
let fails = 0
const eq = (n: string, got: unknown, want: unknown) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${n}: ${JSON.stringify(got)}${ok ? '' : ` want ${JSON.stringify(want)}`}`) }
const reply = 'Dear Rhandee,\n\nWe have checked the snapshot provided, and the battery health shown as 83% is above the minimum standard required under Amazon Renewed. We have noted your request for a replacement with a better battery. However, we are unable to send a replacement before receiving and inspecting the original device.\n\nKind regards,\nCustomer Support Team'
const [k] = await sql`INSERT INTO cases (case_ref, subject, status, customer_first_name, source, last_customer_message_at) VALUES (${'RIQ-G' + Math.floor(Math.random() * 1e6)}, 'Battery', 'open', 'Rhandee', 'gmail', now()) RETURNING id`
const at = (h: number) => new Date(Date.UTC(2026, 10, 16, h))
const [d] = await sql`INSERT INTO drafts (case_id, draft_text, original_text, status, created_at) VALUES (${k.id}, ${reply}, ${reply}, 'draft', ${at(16)}) RETURNING id`
// 16 Nov 17:57: sent from Seller Central; Amazon's copy (no greeting) syncs in
const copy = reply.replace('Dear Rhandee,\n\n', '')
await sql`INSERT INTO messages (case_id, direction, sender, body, kind, sent_at) VALUES (${k.id}, 'outbound', 'Saigates Support (via Seller Central)', ${copy}, 'seller_central_copy', ${at(17)})`
eq('copy marks pending draft sent', await markDraftsSentFromCopy(sql, k.id, copy, at(17)), [d.id])
eq('draft status', (await sql`SELECT status, sent_via FROM drafts WHERE id = ${d.id}`)[0], { status: 'sent', sent_via: 'seller_central' })
// Someone makes the same text again in a new draft → send would be stopped
eq('already sent found', !!(await findAlreadySent(sql, k.id, reply)), true)
eq('different reply not blocked', !!(await findAlreadySent(sql, k.id, 'Dear Rhandee,\n\nYes, that works for us. Keep the phone until the new one arrives, then send it back and we will refund you after checking it.\n\nKind regards')), false)
// 17 Nov 04:46: she writes again → a draft from 16 Nov is out of date
await sql`INSERT INTO messages (case_id, direction, sender, body, kind, sent_at) VALUES (${k.id}, 'inbound', 'Customer', 'What you are asking is not possible...', 'message', ${new Date(Date.UTC(2026, 10, 17, 4, 46))})`
eq('customer wrote since draft', (await customerWroteSince(sql, k.id, at(16))).length, 1)
eq('nothing new since 05:00 on 17 Nov', (await customerWroteSince(sql, k.id, new Date(Date.UTC(2026, 10, 17, 5)))).length, 0)
await sql`UPDATE cases SET archived_at = now() WHERE id = ${k.id}`; await sql.end()
if (fails) process.exit(1)
