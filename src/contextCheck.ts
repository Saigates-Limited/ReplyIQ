// Context check: the word/number rules in serverChecks() are a fast first pass. A few of them are judgement calls that
// words alone get wrong ("pass your request to the team for review" is not asking for a review; "we have noted your
// request for a £50 refund" is not offering £50). When one of those fires, ask the model once, with the conversation,
// whether the reply really does that. If it says no, the finding is cleared (kept in server_findings as severity
// 'cleared' with the reason, so staff can see why). If the model cannot be reached, the finding stays: fail-safe.
import type { Bindings } from './db'
import { buildPayload, MODEL, type ServerFinding, type CaseRow, type MessageRow, type EventRow } from './ai'

/** Rules that need context. Everything else (personal data, statutory wording, bank details, ...) stays word-based. */
export const CONTEXT_RULES: Record<string, string> = {
  never_reviews:
    'Does the reply ask, encourage, thank, or bargain about the customer leaving, changing or removing a product review, seller feedback or a star rating? Using "review" to mean "look into, assess or check" does NOT count.',
  refund_over_15:
    'Does the reply itself offer, promise, agree to or confirm that WE will give the customer a partial refund, credit, goodwill or compensation payment of MORE than £15 (for example if they keep the phone)? Repeating or acknowledging an amount the customer asked for, quoting the order price, or the normal full refund after an Amazon return does NOT count.',
  never_refund_issued:
    'Does the reply state that a refund HAS ALREADY been issued or processed? Future or conditional wording ("once we receive it, the refund will be issued") does NOT count.',
  never_no_rights:
    'Does the reply tell the customer they have no rights, no valid claim, or are not entitled to anything? Saying a specific request cannot be met while offering the normal options does NOT count.',
  price_unapproved:
    'Does the reply quote an amount the customer must PAY us (for example a repair price)? The order price, amounts the customer mentioned, refund amounts, or Amazon fees do NOT count.',
  safety_stop_using:
    'Should THIS reply tell the customer to stop using and charging the phone? It applies only if the phone is still with the customer and the conversation shows a current swelling, heat, smoke or lifting-screen risk. It does NOT apply if the phone has already been returned to or received by us, or the customer has said it was sent back.',
  price_mismatch:
    'Does the reply quote a price for the customer to PAY us that differs from the approved repair price? The order price or amounts the customer mentioned do NOT count.',
}

export type Finding = ServerFinding | { rule: string; severity: 'cleared'; detail: string; text_hash: string }

/** Short stable hash of the reply text, so a clearance only applies to the exact text it was made for. */
export function textHash(s: string): string {
  let h = 0x811c9dc5
  for (const ch of s.trim()) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16)
}

type Verdict = { applies: boolean; why: string }

async function askModel(env: Bindings, kase: CaseRow, messages: MessageRow[], events: EventRow[], draft: string, rules: string[]): Promise<Record<string, Verdict> | null> {
  if (!env.OPENAI_API_KEY) return null
  const base = (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 25000)
  try {
    const payload = buildPayload(kase, messages, { events })
    const thread = payload.thread.slice(-10).map((m) => `[${m.from} @ ${m.sent_at}]\n${m.text}`).join('\n\n')
    const user = `CONVERSATION (oldest first, most recent last):\n${thread}\n\nREPLY WE ARE ABOUT TO SEND:\n${draft.slice(0, 8000)}\n\nQUESTIONS (judge the reply's meaning in this conversation, not single words):\n${rules.map((r) => `- ${r}: ${CONTEXT_RULES[r]}`).join('\n')}\n\nReturn JSON: {${rules.map((r) => `"${r}": {"applies": true|false, "why": "<one short sentence quoting the words that decide it>"}`).join(', ')}}`
    // Same privacy guards as drafting: no returns-desk or refund-email data.
    if (/SPC-[A-Za-z]+-\d{6,}/.test(user) || /refund_initiated/.test(user)) return null
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: MODEL, store: false, response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You check a customer-service reply from a UK seller of renewed phones on Amazon for specific policy problems. Answer each question about what the reply actually says and commits to, in the context of the conversation. When unsure, answer applies: true.' },
          { role: 'user', content: user },
        ],
      }),
    })
    if (!res.ok) return null
    const data: any = await res.json()
    const parsed = JSON.parse(String(data.choices?.[0]?.message?.content ?? '{}'))
    const out: Record<string, Verdict> = {}
    for (const r of rules) {
      const v = parsed?.[r]
      if (v && typeof v.applies === 'boolean') out[r] = { applies: v.applies, why: String(v.why ?? '').slice(0, 300) }
    }
    return out
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

/** Run serverChecks' context-dependent findings past the model. Returns the findings to store (open + cleared). */
export async function reviewInContext(env: Bindings, kase: CaseRow, messages: MessageRow[], events: EventRow[], draft: string, findings: ServerFinding[]): Promise<Finding[]> {
  const rules = [...new Set(findings.filter((f) => CONTEXT_RULES[f.rule]).map((f) => f.rule))]
  if (!rules.length) return findings
  const verdicts = await askModel(env, kase, messages, events, draft, rules)
  if (!verdicts) return findings
  const hash = textHash(draft)
  const out: Finding[] = []
  for (const f of findings) {
    const v = verdicts[f.rule]
    if (v && v.applies === false) out.push({ rule: f.rule, severity: 'cleared', detail: `${f.detail}: cleared in context. ${v.why}`.trim(), text_hash: hash })
    else out.push(f)
  }
  return out
}

/** Re-checks at approve/send time are word-based and synchronous. Drop any finding that the context check cleared for
 *  this exact text (the send route already insists the text matches the saved draft). */
export function applyCleared(fresh: ServerFinding[], stored: unknown, text: string): ServerFinding[] {
  const hash = textHash(text)
  const cleared = new Set(((Array.isArray(stored) ? stored : []) as any[]).filter((f) => f?.severity === 'cleared' && f.text_hash === hash).map((f) => f.rule))
  return fresh.filter((f) => !cleared.has(f.rule))
}

export const openFindings = (fs: Finding[]) => fs.filter((f): f is ServerFinding => f.severity === 'fail' || f.severity === 'warn')
