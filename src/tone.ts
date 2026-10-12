// Tone classification for customer messages. Small, cheap model; input is already PII-redacted.
import type { Bindings } from './db'

export const TONE_MODEL = 'gpt-6-luna' // OpenAI's current cost-efficient model (gpt-5-mini is marked Deprecated in OpenAI's docs)
export const TONES = ['angry', 'dispute', 'frustrated', 'worried', 'neutral', 'happy'] as const
export type Tone = (typeof TONES)[number]
export const TONE_META: Record<Tone, { word: string; colour: string; rank: number }> = {
  angry:      { word: 'ANGRY/ESCALATING', colour: 'red',    rank: 0 },
  dispute:    { word: 'DISPUTE/LEGAL',    colour: 'purple', rank: 1 },
  frustrated: { word: 'FRUSTRATED',       colour: 'orange', rank: 2 },
  worried:    { word: 'WORRIED/CONFUSED', colour: 'yellow', rank: 3 },
  neutral:    { word: 'NEUTRAL',          colour: 'blue',   rank: 4 },
  happy:      { word: 'HAPPY',            colour: 'green',  rank: 5 },
}

const SYSTEM = `Classify the tone of a customer message to an Amazon UK seller. Reply with JSON only: {"tone": one of angry|dispute|frustrated|worried|neutral|happy}.
- angry: hostile, threatening to escalate, shouting, demands with ultimatums.
- dispute: mentions legal action, Trading Standards, Consumer Rights Act, solicitor, chargeback, A-to-Z claim, formal complaint, "my rights".
- frustrated: annoyed, repeating themselves, disappointed with handling, but not hostile.
- worried: anxious, confused, asking what to do, unsure about product or process.
- neutral: plain factual question or statement.
- happy: thanks, satisfied, positive.
If both angry and dispute apply, choose dispute.`

export async function classifyTone(env: Bindings, redactedText: string): Promise<{ label: Tone; model: string } | null> {
  if (!env.OPENAI_API_KEY || !redactedText.trim()) return null
  const base = (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: TONE_MODEL,
      store: false,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: redactedText.slice(0, 3000) }],
    }),
  })
  if (!res.ok) throw new Error(`tone model ${res.status}`)
  const data: any = await res.json()
  try {
    const t = String(JSON.parse(data.choices?.[0]?.message?.content ?? '{}').tone ?? '').toLowerCase()
    return (TONES as readonly string[]).includes(t) ? { label: t as Tone, model: TONE_MODEL } : null
  } catch { return null }
}
