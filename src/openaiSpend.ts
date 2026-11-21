// Settings → OpenAI spend (Sagar, 21 Nov 2026): month-by-month cost from OpenAI's Costs API.
// The Costs API needs an organisation ADMIN key (sk-admin-…); the drafting key cannot read billing. A manager pastes it into
// Settings, where it is stored encrypted (AES-256-GCM, TOKEN_ENC_KEY) and never shown again; or it can be set as the
// OPENAI_ADMIN_KEY Worker secret. Results are cached for an hour.
import type { Bindings, Sql } from './db'
import { encryptToken, decryptToken } from './gmail'

const API = 'https://api.openai.com/v1'
const CACHE_MINUTES = 60

export async function adminKey(env: Bindings, sql: Sql): Promise<{ key: string | null; source: 'secret' | 'settings' | null; last4: string | null }> {
  const secret = (env as any).OPENAI_ADMIN_KEY as string | undefined
  if (secret) return { key: secret, source: 'secret', last4: secret.slice(-4) }
  try {
    const [r] = await sql`SELECT value FROM app_settings WHERE key = 'openai_admin_key'`
    const v = typeof r?.value === 'string' ? JSON.parse(r.value) : r?.value
    if (v?.enc) { const key = await decryptToken(env, v.enc); return { key, source: 'settings', last4: key.slice(-4) } }
  } catch {}
  return { key: null, source: null, last4: null }
}

export async function saveAdminKey(env: Bindings, sql: Sql, key: string | null, userId: number) {
  if (!key) { await sql`DELETE FROM app_settings WHERE key IN ('openai_admin_key', 'openai_spend_cache')`; return }
  await sql`INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ('openai_admin_key', ${sql.json({ enc: await encryptToken(env, key) } as any)}, ${userId}, now())
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`
  await sql`DELETE FROM app_settings WHERE key = 'openai_spend_cache'`
}

async function get(key: string, path: string, f: typeof fetch) {
  const res = await f(`${API}${path}`, { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } })
  const txt = await res.text()
  if (!res.ok) {
    let msg = txt.slice(0, 200)
    try { msg = JSON.parse(txt)?.error?.message ?? msg } catch {}
    throw new Error(res.status === 401 || res.status === 403 ? `OpenAI refused the admin key (${res.status}): ${msg}` : `OpenAI error ${res.status}: ${msg}`)
  }
  return JSON.parse(txt)
}

export type MonthSpend = { month: string; label: string; total: number; projects: Record<string, number> }

/** Daily cost buckets from the first day of the month `months - 1` months ago, grouped by project, summed into calendar months (UTC). */
export async function fetchSpend(key: string, months = 12, now = new Date(), f: typeof fetch = fetch) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1))
  const byMonth = new Map<string, MonthSpend>()
  for (let i = 0; i < months; i++) {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1))
    const m = d.toISOString().slice(0, 7)
    byMonth.set(m, { month: m, label: d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }), total: 0, projects: {} })
  }
  let page: string | null = null, currency = 'usd'
  for (let i = 0; i < 6; i++) {
    const qs = new URLSearchParams({ start_time: String(Math.floor(start.getTime() / 1000)), bucket_width: '1d', limit: '180' })
    qs.append('group_by', 'project_id')
    if (page) qs.set('page', page)
    const j: any = await get(key, `/organization/costs?${qs}`, f)
    for (const b of j.data ?? []) {
      const m = new Date(b.start_time * 1000).toISOString().slice(0, 7)
      const row = byMonth.get(m)
      if (!row) continue
      for (const r of b.results ?? []) {
        const v = Number(r.amount?.value ?? 0)
        if (r.amount?.currency) currency = r.amount.currency
        row.total += v
        const p = r.project_id ?? 'unassigned'
        row.projects[p] = (row.projects[p] ?? 0) + v
      }
    }
    if (!j.has_more || !j.next_page) break
    page = j.next_page
  }
  // Project names (falls back to the id if the key can't list projects).
  const names: Record<string, string> = {}
  try { const p: any = await get(key, '/organization/projects?limit=100&include_archived=true', f); for (const x of p.data ?? []) names[x.id] = x.name } catch {}
  const list = [...byMonth.values()].map((m) => ({ ...m, total: Math.round(m.total * 100) / 100,
    projects: Object.fromEntries(Object.entries(m.projects).map(([k, v]) => [names[k] ?? k, Math.round(v * 100) / 100]).sort((a, b) => (b[1] as number) - (a[1] as number))) }))
  return { currency: currency.toUpperCase(), months: list, fetched_at: new Date().toISOString() }
}

export async function spendWithCache(env: Bindings, sql: Sql, opts: { refresh?: boolean } = {}) {
  const k = await adminKey(env, sql)
  if (!k.key) return { configured: false as const }
  if (!opts.refresh) {
    const [c] = await sql`SELECT value, updated_at FROM app_settings WHERE key = 'openai_spend_cache'`.catch(() => [] as any[])
    if (c && Date.now() - new Date(c.updated_at).getTime() < CACHE_MINUTES * 60_000)
      return { configured: true as const, source: k.source, last4: k.last4, ...(typeof c.value === 'string' ? JSON.parse(c.value) : c.value) }
  }
  const data = await fetchSpend(k.key)
  await sql`INSERT INTO app_settings (key, value, updated_at) VALUES ('openai_spend_cache', ${sql.json(data as any)}, now())
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`.catch(() => {})
  return { configured: true as const, source: k.source, last4: k.last4, ...data }
}
