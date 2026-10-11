// Seeds / upserts staff users. Usage:
//   DATABASE_URL=postgres://... node scripts/seed-users.mjs
// Passwords come from env (so none are committed): SEED_MANAGER_PASSWORD, SEED_AGENT_PASSWORD
import postgres from 'postgres'
import { webcrypto as crypto } from 'node:crypto'

const ITER = 100_000
const b64 = (buf) => Buffer.from(buf).toString('base64')
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITER }, key, 256)
  return `pbkdf2$${ITER}$${b64(salt)}$${b64(bits)}`
}

const url = process.env.DATABASE_URL
if (!url) { console.error('DATABASE_URL required'); process.exit(1) }
const managerPw = process.env.SEED_MANAGER_PASSWORD
const agentPw = process.env.SEED_AGENT_PASSWORD
if (!managerPw || !agentPw) { console.error('SEED_MANAGER_PASSWORD and SEED_AGENT_PASSWORD required'); process.exit(1) }

const sql = postgres(url, { max: 1 })
const users = [
  { email: 'manager@saigates.co.uk', name: 'Sagar (Manager)', role: 'manager', pw: managerPw },
  { email: 'agent@saigates.co.uk', name: 'Priya Agent', role: 'agent', pw: agentPw },
]
for (const u of users) {
  const hash = await hashPassword(u.pw)
  await sql`INSERT INTO users (email, name, role, password_hash) VALUES (${u.email}, ${u.name}, ${u.role}, ${hash})
            ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, password_hash = EXCLUDED.password_hash, is_active = TRUE`
  console.log(`upserted ${u.role}: ${u.email}`)
}
await sql.end()
