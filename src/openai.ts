// One place for every OpenAI call, with a fallback model (Sagar, 22 Nov 2026).
// The primary model is GPT-5.5. If it is unavailable (retired, model not found, OpenAI server errors, time-outs),
// the same request is retried once on the fallback model. Running out of credits does NOT switch models: both share the account.
import type { Bindings } from './db'

export const PRIMARY_MODEL = 'gpt-5.5'
export const FALLBACK_MODEL = 'gpt-6.1-sol'
export const models = (env: Bindings) => ({
  primary: ((env as any).OPENAI_MODEL as string) || PRIMARY_MODEL,
  fallback: ((env as any).OPENAI_FALLBACK_MODEL as string) || FALLBACK_MODEL,
})

export class OpenAIError extends Error {
  constructor(public status: number, public body: string, public model: string) { super(`OpenAI error ${status} (${model}): ${body.slice(0, 300)}`) }
}

/** Errors where trying another model makes sense. Not quota/billing, not bad requests about our own content. */
export function shouldFallBack(status: number, body: string): boolean {
  if (status === 0) return true // network error / time-out
  if (status >= 500) return true
  if (status === 404 || status === 410) return true
  if (/insufficient_quota|billing|no credits/i.test(body)) return false
  if (status === 400 || status === 403) return /model|deprecat|retired|does not exist|not supported|unsupported/i.test(body)
  if (status === 429) return /overloaded|capacity/i.test(body)
  return false
}

type ChatBody = { messages: { role: string; content: string }[]; response_format?: unknown; [k: string]: unknown }

/** POST /chat/completions with the primary model, then the fallback if the primary is unavailable. Returns the JSON and the model used. */
export async function chat(env: Bindings, body: ChatBody, opts: { timeoutMs?: number; model?: string; noFallback?: boolean } = {}, f: typeof fetch = fetch) {
  const base = (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')
  const { primary, fallback } = models(env)
  const order = opts.model ? [opts.model] : opts.noFallback || primary === fallback ? [primary] : [primary, fallback]
  let last: OpenAIError | null = null
  for (const model of order) {
    const ctl = new AbortController()
    const t = opts.timeoutMs ? setTimeout(() => ctl.abort(), opts.timeoutMs) : null
    try {
      const res = await f(`${base}/chat/completions`, {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
        body: JSON.stringify({ ...body, model, store: false }),
      })
      if (res.ok) {
        if (model !== order[0]) console.warn(`OpenAI: used fallback model ${model} after: ${last?.message}`)
        return { data: (await res.json()) as any, model }
      }
      const txt = await res.text()
      last = new OpenAIError(res.status, txt, model)
      if (!shouldFallBack(res.status, txt)) throw last
    } catch (e: any) {
      if (e instanceof OpenAIError && !shouldFallBack(e.status, e.body)) throw e
      if (!(e instanceof OpenAIError)) last = new OpenAIError(0, String(e?.name === 'AbortError' ? 'timed out' : e?.message ?? e), model)
    } finally {
      if (t) clearTimeout(t)
    }
  }
  throw last ?? new OpenAIError(0, 'no model tried', primary)
}
