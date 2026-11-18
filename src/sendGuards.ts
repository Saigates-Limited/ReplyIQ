// Guards that stop a reply going out that the customer would read as automatic (RIQ-1300, 17 Nov 2026):
//  1. Already sent  — the same text already went out (by ReplyIQ or pasted into Seller Central).
//  2. Customer wrote since — the customer wrote again after the draft was written or last edited.
//  3. Repeats an earlier reply — a sentence copied word for word from a reply we already sent (warning only).
import type { Sql } from './db'

const words = (s: string) => String(s || '').toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9£%'.]+/g, ' ').split(' ').filter(Boolean)
const shingles = (s: string, n = 4) => {
  const w = words(s); const out = new Set<string>()
  if (w.length < n) { if (w.length) out.add(w.join(' ')); return out }
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '))
  return out
}

/** How much of `a` appears in `b`, and of `b` in `a` (0..1), by overlapping 4-word runs. */
export function overlap(a: string, b: string): { aInB: number; bInA: number } {
  const A = shingles(a), B = shingles(b)
  if (!A.size || !B.size) return { aInB: 0, bInA: 0 }
  let both = 0
  for (const s of A) if (B.has(s)) both++
  return { aInB: both / A.size, bInA: both / B.size }
}

/** Same reply, allowing for small edits, a missing greeting or Amazon trimming the copy. */
export const sameReply = (draft: string, sent: string) => { const o = overlap(draft, sent); return o.aInB >= 0.85 && o.bInA >= 0.85 }

/** An outbound message on the case whose text is this reply. */
export async function findAlreadySent(sql: Sql, caseId: number, text: string) {
  const rows = await sql`SELECT id, body, sent_at, kind, sender FROM messages
                         WHERE case_id = ${caseId} AND direction = 'outbound' AND kind IS DISTINCT FROM 'event'
                         ORDER BY sent_at DESC LIMIT 30`
  return (rows as any[]).find((m) => sameReply(text, m.body)) ?? null
}

/** Customer messages that arrived after `since` (when the draft was written or last edited). */
export async function customerWroteSince(sql: Sql, caseId: number, since: Date | string) {
  return sql`SELECT id, body, sent_at FROM messages
             WHERE case_id = ${caseId} AND direction = 'inbound' AND kind = 'message' AND sent_at > ${new Date(since)}
             ORDER BY sent_at ASC LIMIT 10`
}

/** Seller Central copy just synced: mark pending drafts with the same text as sent, so nobody sends them again. */
export async function markDraftsSentFromCopy(sql: Sql, caseId: number, copyText: string, at: Date) {
  if (words(copyText).length < 6) return []
  const pending = await sql`SELECT id, draft_text FROM drafts WHERE case_id = ${caseId} AND status IN ('draft','pending_approval','approved') AND created_at < ${at}`
  const done: number[] = []
  for (const d of pending as any[]) {
    const o = overlap(copyText, d.draft_text) // Amazon's copy can drop the greeting/sign-off: most of the copy must be in the draft
    if ((o.aInB >= 0.8 && o.bInA >= 0.5) || (o.aInB >= 0.95 && o.bInA >= 0.35 && words(copyText).length >= 8)) {
      const u = await sql`UPDATE drafts SET status = 'sent', sent_via = 'seller_central', sent_recorded_at = ${at}, updated_at = now(),
                            staff_notes = concat_ws(E'\\n', NULLIF(staff_notes, ''), 'Marked as sent automatically: the same text was sent from Seller Central.')
                          WHERE id = ${d.id} AND status IN ('draft','pending_approval','approved') RETURNING id`
      if (u.length) done.push(d.id)
    }
  }
  return done
}

// Lines every reply is allowed to share (greeting, thanks, closing, sign-off).
const STOCK = [/^dear\b/, /^hi\b/, /^hello\b/, /^thank you for (your|the) (message|patience|reply|response)/, /^we understand your concern/,
  /^if you need any further help/, /^kind regards/, /^customer support team/, /^we'?re sorry to hear/, /^we are sorry to hear/]

/** Sentences of 8+ words that already went out word for word in an earlier reply on this case. */
export function repeatedFromEarlier(draft: string, earlier: { body: string; sent_at: string | Date }[]) {
  const sentences = String(draft || '').split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => words(s).length >= 8)
  const out: { sentence: string; sent_at: string | Date }[] = []
  for (const s of sentences) {
    const w = words(s), n = w.join(' ')
    if (STOCK.some((r) => r.test(n))) continue
    // The whole sentence, or any run of 10 identical words inside it (a reworded opening around the same long phrase).
    const runs = w.length <= 10 ? [n] : Array.from({ length: w.length - 9 }, (_, i) => w.slice(i, i + 10).join(' '))
    const hit = earlier.find((m) => { const e = ' ' + words(m.body).join(' ') + ' '; return runs.some((r) => e.includes(' ' + r + ' ')) })
    if (hit) out.push({ sentence: s, sent_at: hit.sent_at })
  }
  return out
}

/** Warning finding for the draft panel when a follow-up copies earlier wording. */
export function repeatFinding(draft: string, messages: { direction: string; body: string; sent_at: any; kind?: string | null }[]) {
  const earlier = messages.filter((m) => m.direction === 'outbound' && m.kind !== 'event')
  const reps = repeatedFromEarlier(draft, earlier)
  if (!reps.length) return null
  const first = reps[0].sentence.length > 90 ? reps[0].sentence.slice(0, 87) + '…' : reps[0].sentence
  return { rule: 'repeats_earlier_reply', severity: 'warn' as const,
    detail: `Repeats ${reps.length} sentence${reps.length > 1 ? 's' : ''} already sent in an earlier reply (e.g. "${first}"). Customers read repeated wording as automatic; refer back instead.` }
}
