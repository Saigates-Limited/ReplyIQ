// Settings → OpenAI spend. Managers only: billing figures, and the admin key that reads them.
import { Hono } from 'hono'
import { getDb, type Bindings } from '../db'
import { requireManager, type Vars } from '../auth'
import { spendWithCache, saveAdminKey } from '../openaiSpend'
import { logSecurity, clientIp } from '../security'

export const spendApi = new Hono<{ Bindings: Bindings; Variables: Vars }>()
spendApi.use('*', requireManager)

spendApi.get('/', async (c) => {
  const sql = getDb(c.env)
  try { return c.json(await spendWithCache(c.env, sql, { refresh: c.req.query('refresh') === '1' })) }
  catch (e: any) { return c.json({ configured: true, error: e.message }, 502) }
  finally { await sql.end() }
})

// Save (or remove, with an empty key) the admin key. It is checked against OpenAI before it is stored, and never returned.
spendApi.put('/key', async (c) => {
  const key = String(((await c.req.json().catch(() => ({}))) as any).key ?? '').trim()
  if (key && !/^sk-admin-[A-Za-z0-9_-]{20,}$/.test(key)) return c.json({ error: 'That is not an OpenAI admin key. It starts with sk-admin- (OpenAI → Settings → Organization → Admin keys).' }, 400)
  const sql = getDb(c.env)
  try {
    if (key) {
      const res = await fetch('https://api.openai.com/v1/organization/projects?limit=1', { headers: { Authorization: `Bearer ${key}` } })
      if (!res.ok) return c.json({ error: `OpenAI did not accept this key (${res.status}). Check it is an admin key with read access.` }, 400)
    }
    await saveAdminKey(c.env, sql, key || null, c.get('user').id)
    await logSecurity(sql, { event: 'setting_changed', user_id: c.get('user').id, email: c.get('user').email, ip: clientIp(c), detail: { setting: 'openai_admin_key', action: key ? 'saved' : 'removed' } })
    return c.json({ ok: true })
  } finally {
    await sql.end()
  }
})
