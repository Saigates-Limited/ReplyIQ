// Fallback model: GPT-5.5 first; gpt-6.1-sol only when GPT-5.5 is unavailable (not for quota or our own bad requests).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chat, shouldFallBack } from '../src/openai'

const env: any = { OPENAI_API_KEY: 'k' }
const fake = (answers: Record<string, [number, string]>) => {
  const seen: string[] = []
  const f = (async (_u: string, init: any) => { const m = JSON.parse(init.body).model; seen.push(m); const [st, body] = answers[m] ?? [200, '{"choices":[{"message":{"content":"{}"}}]}']; return new Response(body, { status: st }) }) as any
  return { f, seen }
}
const body = { messages: [{ role: 'user', content: 'hi' }] }

test('primary works: fallback never called', async () => {
  const { f, seen } = fake({})
  const r = await chat(env, body, {}, f)
  assert.equal(r.model, 'gpt-5.5'); assert.deepEqual(seen, ['gpt-5.5'])
})
test('primary retired / not found: fallback used', async () => {
  const { f, seen } = fake({ 'gpt-5.5': [404, '{"error":{"message":"The model `gpt-5.5` does not exist"}}'] })
  const r = await chat(env, body, {}, f)
  assert.equal(r.model, 'gpt-6.1-sol'); assert.deepEqual(seen, ['gpt-5.5', 'gpt-6.1-sol'])
})
test('server error: fallback used', async () => {
  const { f } = fake({ 'gpt-5.5': [503, 'overloaded'] })
  assert.equal((await chat(env, body, {}, f)).model, 'gpt-6.1-sol')
})
test('out of credits: no fallback, error shown', async () => {
  const { f, seen } = fake({ 'gpt-5.5': [429, '{"error":{"code":"insufficient_quota","message":"You have no credits remaining"}}'] })
  await assert.rejects(chat(env, body, {}, f), /429/); assert.deepEqual(seen, ['gpt-5.5'])
})
test('both down: the last error is reported', async () => {
  const { f } = fake({ 'gpt-5.5': [500, 'x'], 'gpt-6.1-sol': [500, 'y'] })
  await assert.rejects(chat(env, body, {}, f), /gpt-6\.1-sol/)
})
test('a fixed model (tone) is used alone', async () => {
  const { f, seen } = fake({})
  await chat(env, body, { model: 'gpt-6-luna' }, f); assert.deepEqual(seen, ['gpt-6-luna'])
})
test('store:false is always sent', async () => {
  let sent: any; const f = (async (_u: string, init: any) => { sent = JSON.parse(init.body); return new Response('{}') }) as any
  await chat(env, body, {}, f); assert.equal(sent.store, false)
})
test('which errors switch models', () => {
  assert.equal(shouldFallBack(400, 'model gpt-5.5 has been deprecated'), true)
  assert.equal(shouldFallBack(400, 'Invalid JSON in messages'), false)
  assert.equal(shouldFallBack(401, 'bad key'), false)
  assert.equal(shouldFallBack(0, 'timed out'), true)
})
