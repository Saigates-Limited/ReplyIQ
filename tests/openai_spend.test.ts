// OpenAI spend: daily cost buckets (Costs API) summed into calendar months, with project names.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchSpend } from '../src/openaiSpend'

const day = (iso: string) => Math.floor(new Date(iso).getTime() / 1000)
test('sums daily buckets into months, follows pages, names projects', async () => {
  const calls: string[] = []
  const f = (async (url: string, init: any) => {
    calls.push(url)
    assert.equal(init.headers.Authorization, 'Bearer sk-admin-test')
    if (url.includes('/organization/projects')) return new Response(JSON.stringify({ data: [{ id: 'proj_r', name: 'ReplyIQ' }] }))
    const page2 = url.includes('page=p2')
    const data = page2
      ? [{ start_time: day('2026-11-20T00:00:00Z'), results: [{ amount: { value: 1.25, currency: 'usd' }, project_id: 'proj_r' }] }]
      : [{ start_time: day('2026-10-31T00:00:00Z'), results: [{ amount: { value: 2.5, currency: 'usd' }, project_id: 'proj_r' }, { amount: { value: 0.5, currency: 'usd' }, project_id: 'proj_x' }] },
         { start_time: day('2026-11-01T00:00:00Z'), results: [{ amount: { value: 3, currency: 'usd' }, project_id: 'proj_r' }] }]
    return new Response(JSON.stringify({ data, has_more: !page2, next_page: page2 ? null : 'p2' }))
  }) as any
  const r = await fetchSpend('sk-admin-test', 3, new Date('2026-11-21T12:00:00Z'), f)
  assert.equal(r.currency, 'USD')
  assert.deepEqual(r.months.map((m) => [m.month, m.total]), [['2026-09', 0], ['2026-10', 3], ['2026-11', 4.25]])
  assert.deepEqual(r.months[1].projects, { ReplyIQ: 2.5, proj_x: 0.5 })
  assert.match(calls[0], /start_time=1788220800/) // 1 Sep 2026 00:00 UTC
  assert.match(calls[0], /group_by=project_id/)
  assert.equal(calls.filter((u) => u.includes('/costs')).length, 2)
})
