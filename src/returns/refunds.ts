// Part 2: "Refund Initiated" emails → amazon_events(kind='refund_initiated'); daily reconciliation; 90-day back-check.
// Rules: manager mailbox (bijalshah.cc@gmail.com) only; buyer name stripped; dedupe by Gmail message id; never sends
// anything; nothing here is ever passed to OpenAI.
import type { Bindings } from '../db'
import { accessToken, listThreadIds, getThread, header, messageBody, GmailQuotaError, listConnections, type GmailMessage } from '../gmail'
import { fetchOrder, spapiConfigured, type SpapiEnv } from '../spapi'
import { parseRefundInitiated, classifyRefundNotice, isPartialRefund } from './refundParser'
import type { Sql } from './service'

export const REFUND_MAILBOX = 'bijalshah.cc@gmail.com'
export const REFUND_SUBJECT = 'Refund Initiated for Order'
export const BACKCHECK_DAYS = 90

export type IngestResult = { messagesNew: number; dup: number; skipped: { id: string; reason: string }[]; rateLimited?: boolean }

/** Which connected mailbox receives refund emails. Falls back to the default mailbox if the configured one is not connected. */
export async function refundMailbox(sql: Sql) {
  const all = await listConnections(sql)
  return all.find((c) => c.enabled && c.email_address.toLowerCase() === REFUND_MAILBOX) ?? all.find((c) => c.enabled && c.is_default) ?? all.find((c) => c.enabled) ?? null
}

/** Store one refund email. Returns 'new' | 'dup' | 'skip'. Idempotent on gmail_message_id. */
export async function ingestRefundEmail(sql: Sql, env: Bindings, m: GmailMessage, mailboxId: number | null): Promise<'new' | 'dup' | 'skip'> {
  const [dup] = await sql`SELECT 1 FROM amazon_events WHERE gmail_message_id = ${m.id}`
  if (dup) return 'dup'
  const subject = header(m, 'Subject')
  const r = parseRefundInitiated(messageBody(m), subject)
  if (!r.orderId) return 'skip'
  const at = new Date(Number(m.internalDate))
  const [k] = await sql`SELECT id FROM cases WHERE order_id = ${r.orderId} ORDER BY id LIMIT 1`
  // Partial? Compare against the order's item price if we know it (case → SP-API), else leave NULL and let reconcile fill it.
  let isPartial: boolean | null = null
  const unit = await orderUnitPrice(sql, env, r.orderId, r.items[0]?.sku ?? null)
  if (unit != null && r.items[0]) isPartial = isPartialRefund(r.items[0].item_refund, unit, r.items[0].quantity ?? 1)
  const [ret] = await sql`SELECT id, status FROM returns WHERE order_id = ${r.orderId} ORDER BY created_at DESC LIMIT 1`.catch(() => [] as any[])
  const [ev] = await sql`
    INSERT INTO amazon_events (case_id, order_id, kind, status, amount, currency, received_at, asin, sku, quantity, product, gmail_message_id, gmail_thread_id, raw_excerpt,
                               refund_reason, spc_ref, refund_items, is_partial, needs_manager, return_id, mailbox_id)
    VALUES (${k?.id ?? null}, ${r.orderId}, 'refund_initiated', 'open', ${r.amount}, ${r.currency ?? 'GBP'}, ${at}, ${r.items[0]?.asin ?? null}, ${r.items[0]?.sku ?? null}, ${r.items[0]?.quantity ?? null}, ${r.items[0]?.name ?? null},
            ${m.id}, ${m.threadId}, ${r.excerpt}, ${r.reason}, ${r.spcRef}, ${sql.json(r.items)}, ${isPartial}, ${!r.knownReason}, ${ret && ['received', 'inspected', 'outcome_agreed', 'closed'].includes(ret.status) ? ret.id : null}, ${mailboxId})
    ON CONFLICT (gmail_message_id) DO NOTHING RETURNING id`
  if (!ev) return 'dup'
  // Timeline entry on the case (no buyer name — the parser already stripped it)
  if (k) await sql`INSERT INTO messages (case_id, direction, sender, body, subject, gmail_message_id, sent_at, kind, event_id, rfc_message_id, mailbox_id)
                   VALUES (${k.id}, 'inbound', 'Amazon Refund', ${`Refund initiated: ${r.currency ?? 'GBP'} ${r.amount?.toFixed(2) ?? '?'} · ${r.reason ?? 'reason not stated'}${r.spcRef ? ` · ${r.spcRef}` : ''}${isPartial ? ' · PARTIAL' : ''}`}, ${subject}, ${m.id}, ${at}, 'event', ${ev.id}, ${header(m, 'Message-ID') || null}, ${mailboxId})`.catch(() => {})
  // Return already in hand → record the refund on it straight away
  if (ret && ['received', 'inspected', 'outcome_agreed'].includes(ret.status)) {
    await sql`UPDATE return_items SET outcome = COALESCE(outcome, ${isPartial ? 'partial_refund' : 'refund'}), refund_amount = COALESCE(refund_amount, ${r.amount}), outcome_at = COALESCE(outcome_at, now()) WHERE return_id = ${ret.id} AND item_no = 1`.catch(() => {})
  }
  return 'new'
}

/** Order item price for the partial-refund check: SP-API Orders when configured (one call per refund email), else unknown. */
async function orderUnitPrice(_sql: Sql, env: Bindings, orderId: string, sku: string | null): Promise<number | null> {
  if (!spapiConfigured(env as SpapiEnv)) return null
  try {
    const o = await fetchOrder(env as SpapiEnv, orderId)
    const it = o.items.find((i) => !sku || (i.sku ?? '').toUpperCase() === sku.toUpperCase()) ?? o.items[0]
    const p = Number(it?.unitPrice)
    return !Number.isNaN(p) && p > 0 ? p : null
  } catch { return null }
}

/** Poll the refund mailbox for refund emails. `days` = lookback; `max` threads per call (throttle). Resumable: dedupe makes re-runs cheap. */
export async function pollRefundEmails(sql: Sql, env: Bindings, opts: { days: number; max?: number; before?: string | null }): Promise<IngestResult> {
  const out: IngestResult = { messagesNew: 0, dup: 0, skipped: [] }
  const mb = await refundMailbox(sql)
  if (!mb) { out.skipped.push({ id: '-', reason: 'no mailbox connected' }); return out }
  const { token } = await accessToken(env, sql, mb.id)
  const q = `from:donotreply@amazon.com subject:"${REFUND_SUBJECT}" newer_than:${Math.max(1, opts.days)}d${opts.before ? ` before:${opts.before}` : ''}`
  const ids = await listThreadIds(token, q, opts.max ?? 40)
  for (const tid of ids) {
    const [seen] = await sql`SELECT 1 FROM amazon_events WHERE kind = 'refund_initiated' AND gmail_thread_id = ${tid} LIMIT 1`
    if (seen) { out.dup++; continue }
    let thread
    try { thread = await getThread(token, tid) } catch (e) { if (e instanceof GmailQuotaError) { out.rateLimited = true; break } throw e }
    for (const m of thread.messages) {
      if (!classifyRefundNotice(header(m, 'From'), header(m, 'Subject'))) continue
      const r = await ingestRefundEmail(sql, env, m, mb.id)
      if (r === 'new') out.messagesNew++; else if (r === 'dup') out.dup++; else out.skipped.push({ id: m.id, reason: 'no order id parsed' })
    }
  }
  return out
}

// ───────── reconciliation ─────────
export type ReconcileResult = { checked: number; ok: number; alerts: number; cleared: number; review: number; errors: string[] }

/** "Shipped" = tracking on the case, or SP-API says Shipped/Delivered. Unknown → null (we do not alert on a guess). */
async function orderShipped(sql: Sql, env: Bindings, orderId: string): Promise<boolean | null> {
  const [k] = await sql`SELECT tracking_number, delivery_date FROM cases WHERE order_id = ${orderId} ORDER BY id LIMIT 1`.catch(() => [] as any[])
  if (k?.tracking_number) return true
  if (k?.delivery_date) return true
  if (spapiConfigured(env as SpapiEnv)) {
    try { const o = await fetchOrder(env as SpapiEnv, orderId); const s = String(o.status ?? '').toLowerCase(); if (o.trackingNumber || o.shipDate) return true; if (/pending|unshipped|canceled|cancelled/.test(s)) return false; if (/shipped/.test(s)) return true } catch { /* unknown */ }
  }
  return null
}

/** Reconcile every refund event that is open, or alerting (re-check daily; clears when the phone is received). */
export async function reconcileRefunds(sql: Sql, env: Bindings): Promise<ReconcileResult> {
  const res: ReconcileResult = { checked: 0, ok: 0, alerts: 0, cleared: 0, review: 0, errors: [] }
  const events = await sql`SELECT id, order_id, refund_reason, status, return_id, sku FROM amazon_events WHERE kind = 'refund_initiated' AND status IN ('open','alert','chasing') ORDER BY received_at ASC LIMIT 300`
  for (const ev of events) {
    res.checked++
    try {
      const [ret] = await sql`SELECT id, status FROM returns WHERE order_id = ${ev.order_id} ORDER BY (status IN ('received','inspected','outcome_agreed','closed')) DESC, created_at DESC LIMIT 1`.catch(() => [] as any[])
      const received = ret && ['received', 'inspected', 'outcome_agreed', 'closed'].includes(ret.status)
      const reason = String(ev.refund_reason ?? '').toLowerCase().trim()
      let result: string, status: string
      if (received) { result = 'ok_return_received'; status = 'ok' }
      else if (reason === 'buyer cancelled') {
        const shipped = await orderShipped(sql, env, ev.order_id)
        if (shipped === false) { result = 'ok_cancelled_before_dispatch'; status = 'ok' }
        else if (shipped === true) { result = 'alert_shipped_not_back'; status = ev.status === 'open' ? 'alert' : ev.status }
        else { result = 'alert_shipped_unknown'; status = ev.status === 'open' ? 'alert' : ev.status } // cannot prove it never shipped → treat as needing eyes
      } else if (reason === 'customer return') { result = 'alert_not_received'; status = ev.status === 'open' ? 'alert' : ev.status }
      else { result = 'alert_review_reason'; status = ev.status === 'open' ? 'alert' : ev.status }
      const wasAlert = ['alert', 'chasing'].includes(ev.status)
      await sql`UPDATE amazon_events SET status = ${status}, reconcile_result = ${result}, reconciled_at = now(), return_id = COALESCE(return_id, ${ret?.id ?? null}), needs_manager = ${result === 'alert_review_reason' || ev.needs_manager === true}, updated_at = now() WHERE id = ${ev.id}`
      if (status === 'ok') { res.ok++; if (wasAlert) res.cleared++ } else { res.alerts++; if (result === 'alert_review_reason') res.review++ }
    } catch (e: any) { res.errors.push(`${ev.order_id}: ${String(e?.message ?? e).slice(0, 120)}`) }
  }
  return res
}

// ───────── daily job ─────────
/** 07:00 Europe/London regardless of BST/GMT. Cron fires at 06:00 and 07:00 UTC; run only when London's hour is 07 and not already run today. */
export function isSevenAmLondon(now = new Date()): boolean {
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false }).format(now))
  return h === 7
}
export const londonYmd = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)

export async function alreadyRanToday(sql: Sql, trigger: string) {
  const [r] = await sql`SELECT 1 FROM sync_runs WHERE trigger = ${trigger} AND started_at >= (${londonYmd()}::date)::timestamptz - interval '1 hour' AND status = 'ok' LIMIT 1`.catch(() => [] as any[])
  return !!r
}

/** Daily refund check: poll yesterday-ish mail, reconcile, advance the 90-day back-check cursor. Logged in sync_runs. */
export async function dailyRefundCheck(sql: Sql, env: Bindings, trigger: 'cron' | 'manual' = 'cron') {
  const [run] = await sql`INSERT INTO sync_runs (trigger) VALUES ('refund_check') RETURNING id`
  const summary: any = { trigger }
  try {
    summary.poll = await pollRefundEmails(sql, env, { days: 3, max: 40 })
    summary.reconcile = await reconcileRefunds(sql, env)
    summary.backcheck = await backcheckStep(sql, env)
    await sql`UPDATE sync_runs SET finished_at = now(), status = ${summary.poll.rateLimited || summary.backcheck?.rateLimited ? 'partial' : 'ok'}, messages_new = ${summary.poll.messagesNew + (summary.backcheck?.messagesNew ?? 0)}, summary = ${sql.json(summary)} WHERE id = ${run.id}`
    return summary
  } catch (e: any) {
    await sql`UPDATE sync_runs SET finished_at = now(), status = 'error', error = ${String(e?.message ?? e).slice(0, 500)}, summary = ${sql.json(summary)} WHERE id = ${run.id}`
    throw e
  }
}

/** 90-day back-check, resumable: walks backwards in 15-day windows, one window per call, cursor in app_settings. */
export async function backcheckStep(sql: Sql, env: Bindings): Promise<(IngestResult & { window?: string; done?: boolean }) | null> {
  const [row] = await sql`SELECT value FROM app_settings WHERE key = 'refund_backcheck'`.catch(() => [] as any[])
  const state = (row?.value as any) ?? { offset: 0, done: false, started: londonYmd() }
  if (state.done) return null
  const WINDOW = 15
  const from = state.offset + WINDOW, before = state.offset
  // Gmail: newer_than:{from}d before:{date} — before: takes YYYY/MM/DD
  const beforeDate = before > 0 ? new Date(Date.now() - before * 86400000) : null
  const r = await pollRefundEmails(sql, env, { days: from, max: 60, before: beforeDate ? beforeDate.toISOString().slice(0, 10).replace(/-/g, '/') : null })
  const next = r.rateLimited ? state : { ...state, offset: from, done: from >= BACKCHECK_DAYS }
  await sql`INSERT INTO app_settings (key, value) VALUES ('refund_backcheck', ${sql.json(next)}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`
  return { ...r, window: `${before}–${from} days ago`, done: next.done }
}
