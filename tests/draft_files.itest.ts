// Integration (scratch DB): files attached to a reply survive regenerated drafts and are what gets sent.
import postgres from 'postgres'
import { addCaseFile, adoptFiles, filesForSend, listCaseFiles } from '../src/draftFiles'
const sql = postgres(process.env.DATABASE_URL!, { prepare: false, fetch_types: false })
let fails = 0
const eq = (n: string, got: unknown, want: unknown) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${n}: ${JSON.stringify(got)}${ok ? '' : ` want ${JSON.stringify(want)}`}`) }
const pdf = Buffer.from('%PDF-1.4 invoice').toString('base64')
const [k] = await sql`INSERT INTO cases (case_ref, subject, status, customer_first_name, source, last_customer_message_at) VALUES (${'T-DF-' + Date.now()}, 'VAT invoice', 'open', 'Ivan', 'gmail', now()) RETURNING id`
const draft = async (status = 'draft') => (await sql`INSERT INTO drafts (case_id, draft_text, original_text, status) VALUES (${k.id}, 'x', 'x', ${status}) RETURNING id`)[0].id
const u = (await sql`SELECT id FROM users ORDER BY id LIMIT 1`)[0].id

// 1. Invoice attached before any draft exists → waits on the case
const a = await addCaseFile(sql, k.id, u, { filename: 'INV-062798.pdf', mime_type: 'application/pdf', base64: pdf })
eq('attached with no draft', [a.ok, (a as any).draft_id], [true, null])
// 2. Draft generated → picks it up (createDraft calls adoptFiles)
const d1 = await draft(); await adoptFiles(sql, k.id, d1)
eq('new draft owns the file', (await listCaseFiles(sql, k.id)).map((f: any) => f.draft_id), [d1])
// 3. Approval round-trip / reload: nothing in the browser matters; the send reads the server copy
eq('send gets the file', (await filesForSend(sql, k.id, d1)).map((f) => [f.filename, f.mimeType, f.size]), [['INV-062798.pdf', 'application/pdf', 16]])
// 4. Agent asks AI to rewrite → old draft discarded, new draft carries the file
await sql`UPDATE drafts SET status = 'discarded' WHERE id = ${d1}`; const d2 = await draft(); await adoptFiles(sql, k.id, d2)
eq('rewrite carries the file', (await filesForSend(sql, k.id, d2)).length, 1)
// 5. Same file twice refused; limits enforced
eq('duplicate refused', (await addCaseFile(sql, k.id, u, { filename: 'INV-062798.pdf', mime_type: 'application/pdf', base64: pdf }) as any).status, 409)
eq('exe refused', (await addCaseFile(sql, k.id, u, { filename: 'x.exe', mime_type: 'application/x-msdownload', base64: pdf }) as any).status, 400)
for (let i = 0; i < 4; i++) await addCaseFile(sql, k.id, u, { filename: `p${i}.pdf`, mime_type: 'application/pdf', base64: pdf })
eq('6th file refused (Amazon max 5)', (await addCaseFile(sql, k.id, u, { filename: 'p9.pdf', mime_type: 'application/pdf', base64: pdf }) as any).status, 400)
// 6. A sent draft's files are never adopted by a later draft
await sql`UPDATE drafts SET status = 'sent' WHERE id = ${d2}`; const d3 = await draft(); await adoptFiles(sql, k.id, d3)
eq('sent draft keeps its own files', (await filesForSend(sql, k.id, d3)).length, 0)
await sql`DELETE FROM draft_files WHERE case_id = ${k.id}`; await sql`UPDATE cases SET archived_at = now() WHERE id = ${k.id}`; await sql.end()
if (fails) process.exit(1)
