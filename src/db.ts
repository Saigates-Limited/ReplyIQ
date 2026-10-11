import postgres from 'postgres'

export type Bindings = {
  DATABASE_URL: string       // Supabase Transaction Pooler URI in production (port 6543)
  OPENAI_API_KEY?: string    // server-only; never exposed to the browser
  OPENAI_BASE_URL?: string   // optional override (defaults to https://api.openai.com/v1)
  GOOGLE_CLIENT_ID?: string  // Gmail integration (future phase)
  GOOGLE_CLIENT_SECRET?: string
}

// One short-lived connection per request on Workers (no long-lived pools at the edge).
// prepare:false is REQUIRED for Supabase's transaction-mode pooler (PgBouncer).
export function getDb(env: Bindings) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not configured')
  const url = new URL(env.DATABASE_URL)
  const wantsSsl = url.searchParams.get('sslmode') === 'require' || !/localhost|127\.0\.0\.1/.test(url.hostname)
  return postgres(env.DATABASE_URL, {
    max: 1,
    prepare: false,
    fetch_types: false,
    idle_timeout: 5,
    connect_timeout: 10,
    ssl: wantsSsl ? 'require' : false,
  })
}

export type Sql = ReturnType<typeof getDb>
