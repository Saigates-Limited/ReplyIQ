import postgres from 'postgres'

export type Bindings = {
  HYPERDRIVE?: Hyperdrive    // Cloudflare Hyperdrive binding → Supabase (production)
  DATABASE_URL?: string      // fallback for local development without Hyperdrive
  OPENAI_API_KEY?: string    // server-only; never exposed to the browser
  OPENAI_BASE_URL?: string   // optional override (defaults to https://api.openai.com/v1)
  GOOGLE_CLIENT_ID?: string  // Gmail integration (future phase)
  GOOGLE_CLIENT_SECRET?: string
  TOKEN_ENC_KEY?: string     // base64 32-byte key for encrypting the Gmail refresh token at rest
  ASSETS: Fetcher            // Workers static assets binding (public/)
}

export const dbConfigured = (env: Bindings) => Boolean(env.HYPERDRIVE?.connectionString || env.DATABASE_URL)

// One short-lived connection per request on Workers.
// Via Hyperdrive the Worker talks to a local Cloudflare endpoint (no TLS needed here — Hyperdrive
// holds the TLS session to Supabase). prepare:false keeps us compatible with pooled connections.
export function getDb(env: Bindings) {
  const viaHyperdrive = Boolean(env.HYPERDRIVE?.connectionString)
  const url = env.HYPERDRIVE?.connectionString || env.DATABASE_URL
  if (!url) throw new Error('Database is not configured (no HYPERDRIVE binding or DATABASE_URL)')
  const host = new URL(url).hostname
  const local = /localhost|127\.0\.0\.1/.test(host)
  return postgres(url, {
    max: 1,
    prepare: false,
    fetch_types: false,
    idle_timeout: 5,
    connect_timeout: 10,
    ssl: viaHyperdrive || local ? false : 'require',
  })
}

export type Sql = ReturnType<typeof getDb>
