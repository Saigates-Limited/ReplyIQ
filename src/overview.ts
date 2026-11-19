// AI Overview for the case page (opened on click only). Two parts:
//  - summary: 2–4 bullets + "what's pending, whose move" — written by the model from the same redacted thread drafting uses;
//  - timeline: built from ReplyIQ's own records (order dates, Amazon notices, messages, ReplyIQ notes). The model only
//    supplies a one-line gist per message; dates and facts never come from the model.
// Same privacy guard as drafting: if the payload would contain returns-desk refs or refund data, no model call is made
// and the timeline is shown with plain excerpts.
import type { Bindings, Sql } from './db'
import { buildPayload, MODEL, type CaseRow, type MessageRow, type EventRow } from './ai'

export type TimelineItem = { at: string; type: 'order' | 'amazon' | 'customer' | 'amazon_cs' | 'us' | 'note'; label: string; detail?: string; who?: string }
export type Overview = { bullets: string[]; pending: string; timeline: TimelineItem[]; ai: boolean; note?: string; generated_at: string }

const EVENT_LABEL: Record<string, string> = {
  return_request: 'Return requested', atoz_claim: 'A-to-Z claim opened', atoz_info_request: 'Amazon asked for A-to-Z information',
  chargeback: 'Chargeback opened', refund: 'Refund issued', safet_claim: 'SAFE-T claim', buyer_message: 'Amazon notice',
}
const money = (amt: unknown, cur: unknown) => (amt ? `${cur === 'GBP' || !cur ? '£' : String(cur) + ' '}${Number(amt).toFixed(2)}` : '')
const short = (s: string, n = 110) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t }

/** Marker that changes when a message arrives or is removed: the cache is reused only while it matches. */
export const sourceMarker = (messages: { id: number }[]) => `${messages.length}:${messages.reduce((m, x) => Math.max(m, x.id), 0)}`

export function buildTimeline(kase: CaseRow & Record<string, any>, messages: (MessageRow & { id: number })[], events: (EventRow & Record<string, any>)[], order: any, gist: Map<number, string>): TimelineItem[] {
  const out: TimelineItem[] = []
  if (order?.orderDate) out.push({ at: order.orderDate, type: 'order', label: 'Order placed', detail: [((order.items || []) as any[]).map((i) => i.title).filter(Boolean).join(', '), money(order.grandTotal, order.currency)].filter(Boolean).join(' · ') })
  if (order?.shipDate) out.push({ at: order.shipDate, type: 'order', label: 'Shipped' })
  if (kase.delivery_date) out.push({ at: new Date(kase.delivery_date).toISOString(), type: 'order', label: kase.delivery_date_source === 'amazon_estimated' ? 'Delivery due (Amazon estimate)' : 'Delivered' })
  for (const e of events) {
    const bits = [e.status && e.status !== 'open' ? e.status.replace(/_/g, ' ') : '', money(e.amount, e.currency), e.return_reason || '', e.customer_comment ? `“${short(e.customer_comment, 80)}”` : '']
    out.push({ at: e.received_at, type: 'amazon', label: EVENT_LABEL[e.kind] || e.kind.replace(/_/g, ' '), detail: bits.filter(Boolean).join(' · ') })
  }
  for (const m of messages) {
    if (m.kind === 'event') {
      // Amazon notices are already above as events; keep ReplyIQ's own notes (invoices, merges, reopened, labels).
      if ((m.sender || '') === 'ReplyIQ') out.push({ at: m.sent_at, type: 'note', label: short(m.body, 120) })
      continue
    }
    const cs = m.direction === 'inbound' && /amazon customer service|on behalf of/i.test(m.sender ?? '')
    const type: TimelineItem['type'] = m.direction === 'outbound' ? 'us' : cs ? 'amazon_cs' : 'customer'
    const who = type === 'us' ? (m.sender || 'Saigates Support').replace(/^Saigates Support\s*/, '').replace(/[()]/g, '').trim() || 'Saigates' : type === 'amazon_cs' ? 'Amazon CS' : kase.customer_first_name || 'Customer'
    out.push({ at: m.sent_at, type, who, label: gist.get(m.id) || short(m.body) })
  }
  return out.filter((x) => x.at).sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
}

async function askModel(env: Bindings, kase: CaseRow, messages: MessageRow[], events: EventRow[]): Promise<{ bullets: string[]; pending: string; gists: { i: number; line: string }[] } | null> {
  if (!env.OPENAI_API_KEY) return null
  const payload = buildPayload(kase, messages, { events })
  const body = JSON.stringify({ case: payload.case, events: payload.events, thread: payload.thread.map((m, i) => ({ i, ...m })) })
  if (/SPC-[A-Za-z]+-\d{6,}/.test(body) || /refund_initiated/.test(body)) return null // same guard as drafting
  const base = (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 30000)
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: MODEL, store: false, response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You summarise a customer-support case for staff at a UK seller of renewed phones on Amazon. Be factual and brief, plain British English, no speculation. Only use what is in the data. Never invent dates, amounts or names.' },
          { role: 'user', content: `CASE DATA (JSON):\n${body}\n\nReturn JSON: {"bullets": [2 to 4 short sentences: what the customer wants, what has happened, what we have done], "pending": "<one sentence: what is outstanding and who has the next move (us, the customer or Amazon)>", "gists": [{"i": <thread index>, "line": "<max 14 words: the gist of that message>"}]} with one gist for every thread item whose from is customer, amazon_cs_on_behalf_of_customer or saigates.` },
        ],
      }),
    })
    if (!res.ok) return null
    const data: any = await res.json()
    const p = JSON.parse(String(data.choices?.[0]?.message?.content ?? '{}'))
    return {
      bullets: (Array.isArray(p.bullets) ? p.bullets : []).map((b: unknown) => short(String(b), 300)).filter(Boolean).slice(0, 4),
      pending: short(String(p.pending ?? ''), 300),
      gists: (Array.isArray(p.gists) ? p.gists : []).filter((g: any) => Number.isInteger(g?.i)).map((g: any) => ({ i: g.i, line: short(String(g.line ?? ''), 140) })),
    }
  } catch { return null } finally { clearTimeout(t) }
}

let tableKnown: boolean | null = null
async function hasTable(sql: Sql) {
  if (tableKnown) return true
  const [r] = await sql`SELECT to_regclass('public.case_overviews') IS NOT NULL AS ok`
  tableKnown = !!r?.ok
  return tableKnown
}

export async function getOverview(env: Bindings, sql: Sql, caseId: number, userId: number, refresh: boolean): Promise<(Overview & { cached: boolean }) | null> {
  const [kase] = await sql<any[]>`SELECT * FROM cases WHERE id = ${caseId}`
  if (!kase) return null
  const messages = await sql<any[]>`SELECT * FROM messages WHERE case_id = ${caseId} ORDER BY sent_at, id`
  const marker = sourceMarker(messages)
  const cacheOk = await hasTable(sql).catch(() => false)
  if (cacheOk && !refresh) {
    const [c] = await sql`SELECT data FROM case_overviews WHERE case_id = ${caseId} AND source_marker = ${marker}`
    if (c) return { ...(c.data as Overview), cached: true }
  }
  const events = await sql<any[]>`SELECT * FROM amazon_events WHERE case_id = ${caseId} ORDER BY received_at`
  const [o] = kase.order_id ? await sql`SELECT payload FROM amazon_orders WHERE order_id = ${kase.order_id}`.catch(() => []) : []
  const ai = await askModel(env, kase, messages, events)
  // Thread indices refer to the last 40 messages, exactly as buildPayload slices them.
  const window = messages.slice(-40)
  const gist = new Map<number, string>()
  for (const g of ai?.gists ?? []) { const m = window[g.i]; if (m && g.line) gist.set(m.id, g.line) }
  const overview: Overview = {
    bullets: ai?.bullets ?? [],
    pending: ai?.pending ?? '',
    timeline: buildTimeline(kase, messages, events, o?.payload ?? null, gist),
    ai: !!ai,
    note: ai ? undefined : 'The AI summary is not available for this case (returns-desk or refund data, or the AI service did not answer). The timeline below is built from ReplyIQ records.',
    generated_at: new Date().toISOString(),
  }
  if (cacheOk) await sql`INSERT INTO case_overviews (case_id, source_marker, data, model, created_by, generated_at)
                         VALUES (${caseId}, ${marker}, ${sql.json(overview as any)}, ${ai ? MODEL : null}, ${userId}, now())
                         ON CONFLICT (case_id) DO UPDATE SET source_marker = EXCLUDED.source_marker, data = EXCLUDED.data, model = EXCLUDED.model,
                           created_by = EXCLUDED.created_by, generated_at = now()`.catch(() => {})
  return { ...overview, cached: false }
}
