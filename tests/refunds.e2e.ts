// Part 2 integration test against the local DB: ingest the two sample refund emails as synthetic Gmail messages, reconcile.
import postgres from 'postgres'
import { ingestRefundEmail, reconcileRefunds } from '../src/returns/refunds'
const sql = postgres('postgres://replyiq:replyiq_dev@localhost:5432/replyiq', { prepare: false, max: 1, fetch_types: false }) as any
const env: any = {}
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url')
const msg = (id: string, subject: string, body: string, date: string) => ({ id, threadId: 't-' + id, internalDate: String(Date.parse(date)), labelIds: [], payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Amazon <donotreply@amazon.com>' }, { name: 'Subject', value: subject }, { name: 'Message-ID', value: `<${id}@amazon.com>` }], body: { data: b64(body) } } })
const S1 = `Hello,\n\nWe initiated a refund of GBP 359.00 to Alex Example for order 205-1900538-4667561 on 4 November 2026.\n\nOrder ID: 205-1900538-4667561\nItem name: Apple iPhone 15 128GB Pink (Renewed)\nASIN: B0CW114X7P\nSKU: I15-128-PNK-A-AMZ1\nReturn quantity: 1\nItem price refund: GBP 359.00\nOutbound delivery cost refund: GBP 0.00\nRefund reason: Buyer Cancelled\n`
const S2 = `We initiated a refund of GBP 223.00 to Sam Example for order 026-9630916-1793908.\nReference: SPC-EUAmazon-2128656218003830\n\nItem: Apple iPhone 13 128GB Midnight (Renewed)  ASIN: B09MGFJK73\nSeller SKU: I13-128-MDT-A-AMZ\nQuantity: 1\nItem price refund: £223.00\nOutbound delivery cost refund: £0.00\nReason: Customer Return\n`
const S3 = S2.replace(/026-9630916-1793908/g, '206-5555555-2222222').replace('SPC-EUAmazon-2128656218003830', 'SPC-EUAmazon-9999999999999999')  // order with a RECEIVED return (#2)
;(async () => {
  for (const [id, subj, body] of [['g1', 'Refund Initiated for Order 205-1900538-4667561', S1], ['g2', 'Refund Initiated for Order 026-9630916-1793908', S2], ['g3', 'Refund Initiated for Order 206-5555555-2222222', S3]] as const) {
    const r = await ingestRefundEmail(sql, env, msg(id, subj, body, '2026-11-04T09:00:00Z'), null)
    console.log(id, '→', r)
  }
  console.log('dup re-ingest →', await ingestRefundEmail(sql, env, msg('g1', 'Refund Initiated for Order 205-1900538-4667561', S1, '2026-11-04T09:00:00Z'), null))
  const rows = await sql`SELECT order_id, status, amount, currency, refund_reason, spc_ref, is_partial, needs_manager, return_id, raw_excerpt FROM amazon_events WHERE kind='refund_initiated' ORDER BY id`
  for (const r of rows) console.log(r.order_id, r.status, r.currency, r.amount, '|', r.refund_reason, '|', r.spc_ref, '| partial', r.is_partial, '| mgr', r.needs_manager, '| return', r.return_id, '| name leaked?', /Alex|Sam Example/.test(r.raw_excerpt))
  // Give the Buyer-Cancelled order a tracking number so it counts as shipped
  await sql`UPDATE cases SET tracking_number = 'JD0001' WHERE order_id = '205-1900538-4667561'`.catch(() => {})
  const rec = await reconcileRefunds(sql, env)
  console.log('reconcile', rec)
  for (const r of await sql`SELECT order_id, status, reconcile_result FROM amazon_events WHERE kind='refund_initiated' ORDER BY id`) console.log(r.order_id, '→', r.status, r.reconcile_result)
  await sql.end()
})()
