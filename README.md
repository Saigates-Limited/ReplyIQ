# ReplyIQ

AI-assisted reply drafting for **Saigates Ltd** Amazon UK customer service.

- **Goal**: answer Amazon UK customer messages inside the 24-hour window with AI drafts that a human always reviews, edits and approves. **Nothing is ever sent to customers automatically.**
- **Stack**: Hono (TypeScript) on Cloudflare Pages/Workers · PostgreSQL (Supabase in production) via postgres.js · OpenAI `gpt-5.5` server-side · Tailwind + vanilla JS
- **Sandbox preview**: https://3000-id2nlba4e4s5y3pr1acd5-02b9cc79.sandbox.novita.ai
  - Demo logins: `manager@saigates.co.uk` / `Manager-Demo-2026!` · `agent@saigates.co.uk` / `Agent-Demo-2026!`

## Features

| Area | Status |
|---|---|
| **Staff login** — email + password (PBKDF2-SHA256, 100k iterations), HttpOnly session cookie (7 days), login throttling. Every page and every `/api/*` route is blocked without a session. | ✅ |
| **Roles** — `agent` and `manager`. Managers get a Staff page to add/deactivate users, change roles and reset passwords. | ✅ |
| **Case queue** sorted by reply deadline (last customer message + 24h, round the clock, no pausing) with overdue / due-soon highlighting and filters | ✅ |
| **Case screen** — email thread, customer panel, auto-saving agent fields (order ID, device model, delivery date, refund issued, A-to-Z open, in stock, approved repair price, tracking number, carrier), case status | ✅ |
| **Generate draft** — server-side call to OpenAI `gpt-5.5` using `reply_instructions.md` as the system prompt; returns the draft, staff notes, decision tree used, PASS/FAIL check and a `needs_manager` flag | ✅ |
| **Guardrail checks** — model self-check **plus** deterministic server checks (PII leakage, unsupported refund/replacement promises, unapproved prices, ID/payment requests, accusations, "waterproof", unsafe charging advice, off-platform dealings, greeting/sign-off). Any server *fail* forces FAIL and blocks approval. | ✅ |
| **Edit → Approve → Mark as sent** — edits are re-checked and un-approve the draft; `needs_manager` drafts can only be approved by a manager; FAIL drafts cannot be approved; "Mark as sent" logs the outbound message on the thread after the agent sends it manually in Amazon | ✅ |
| Transparency — the API returns the exact payload sent to the model (`sent_to_model`) | ✅ |
| Gmail integration | ⏳ redirect URI reserved, see below |

## Privacy: what reaches OpenAI

Built from an explicit allow-list in `src/ai.ts → buildPayload()`:

- `customer_first_name` **only** — never surname, email, phone or address (these live in separate columns that are never read by the AI code path)
- Thread text, after redaction of: the known surname/email/phone/address values, any email address, UK mobile numbers, UK postcodes, and "First Last" signatures
- Agent-filled case fields (order ID, device, dates, yes/no flags, approved price, tracking, carrier)

`OPENAI_API_KEY` is a Cloudflare secret read only inside the Worker. The browser never sees it; the browser only calls `POST /api/cases/:id/drafts`.

## `reply_instructions.md`

Transcribed from the 16 Saigates decision-tree flowcharts (INR, warranty, eSIM, compatibility, battery, safety, authenticity, missing item, change of mind, discount, locked return, OOW repair, device fault 0–30 / 31–90 / 91–365, refund/return) plus universal rules and the JSON output contract. **Replace it with the written version when available** — it is bundled at build time (`import ... '?raw'`), so run `npm run build` after editing.

## API

All routes except `/login`, `POST /api/auth/login|logout`, `/api/health`, `/static/*` and `/auth/google/callback` require a session.

| Method | Path | Who | Description |
|---|---|---|---|
| POST | `/api/auth/login` `{email,password}` | public | Sets session cookie |
| POST | `/api/auth/logout` | public | Clears session |
| GET | `/api/auth/me` | staff | Current user |
| POST | `/api/auth/password` `{current,next}` | staff | Change own password |
| GET/POST | `/api/auth/users` | manager | List / create staff |
| PATCH | `/api/auth/users/:id` `{role,is_active,name,password}` | manager | Update staff |
| GET | `/api/cases?status=active\|open\|awaiting_customer\|resolved\|all` | staff | Queue ordered by deadline |
| GET | `/api/cases/:id` | staff | Case + messages + drafts |
| PATCH | `/api/cases/:id` | staff | Update agent fields / status (422 on bad input) |
| POST | `/api/cases/:id/drafts` | staff | **Generate draft** (OpenAI, server-side) |
| PATCH | `/api/drafts/:id` `{draft_text,staff_notes}` | staff | Edit; re-runs server checks; un-approves |
| POST | `/api/drafts/:id/approve` | staff / **manager if needs_manager** | Approve (blocked if FAIL) |
| POST | `/api/drafts/:id/unapprove` | approver or manager | Withdraw approval |
| POST | `/api/drafts/:id/record-sent` | staff | Log that the approved text was sent manually via Amazon |
| POST | `/api/drafts/:id/discard` | staff | Discard |

## Data model (PostgreSQL) — `db/schema.sql`

- **users** — email, name, role (`agent|manager`), `password_hash`, `is_active`, `last_login_at`
- **sessions** — SHA-256 of cookie token → user, `expires_at`
- **cases** — case metadata, first name separated from PII columns, agent fields, `last_customer_message_at` (deadline derived as +24h)
- **messages** — thread entries (`inbound|outbound`, sender, body, sent_at)
- **drafts** — `tree`, `draft_text`, `original_text`, `staff_notes`, `check_result`, `check_findings` (model), `server_findings`, `needs_manager(+reason)`, `model`, `status` (`draft|approved|sent|discarded`), created/edited/approved/sent audit columns

## Production setup (Supabase + Cloudflare Pages)

### 1. Database — use the **Supabase Transaction Pooler** (recommended over Hyperdrive)

postgres.js on Workers works well against Supabase's Supavisor pooler in **transaction mode** (port **6543**), and this app is already configured for it (`prepare: false`, one connection per request, SSL required). Hyperdrive adds a second component for little gain here; use it later only if you see connection-limit issues.

In Supabase → **Project Settings → Database → Connection string → "Transaction pooler"**, copy the URI. It looks like:

```
postgres://postgres.<project-ref>:<PASSWORD>@aws-0-eu-west-2.pooler.supabase.com:6543/postgres?sslmode=require
```

Apply the schema once (from your machine or this sandbox — Data API off is fine, this is plain Postgres):

```bash
psql "<that URI>" -f db/schema.sql
DATABASE_URL="<that URI>" SEED_MANAGER_PASSWORD='<choose>' SEED_AGENT_PASSWORD='<choose>' node scripts/seed-users.mjs
# (do NOT run db/seed.sql in production — it is demo cases)
```

### 2. Secrets — where to paste them (never in chat, never in git)

**Cloudflare Dashboard → Workers & Pages → your Pages project → Settings → Environment variables → Production → Add variable → tick "Encrypt" (Secret):**

| Name | Value |
|---|---|
| `DATABASE_URL` | the Transaction Pooler URI above |
| `OPENAI_API_KEY` | your OpenAI key (model `gpt-5.5`) |

Or from a terminal with `CLOUDFLARE_API_TOKEN` set:

```bash
npx wrangler pages secret put DATABASE_URL --project-name <project>
npx wrangler pages secret put OPENAI_API_KEY --project-name <project>
```

Redeploy after adding secrets. For local development paste the same values into `.dev.vars` (gitignored).

### 3. Deploy

```bash
npm run build
npx wrangler pages deploy dist --project-name <project>
```

## Gmail (future phase) — Google OAuth redirect URI

Register this **Authorised redirect URI** in Google Cloud → APIs & Services → Credentials → OAuth 2.0 Client (Web application):

```
https://<your-production-domain>/auth/google/callback
```

e.g. `https://replyiq.pages.dev/auth/google/callback` or `https://replyiq.saigates.co.uk/auth/google/callback` if you attach a custom domain. Add the sandbox URL too if you want to test before going live: `https://3000-id2nlba4e4s5y3pr1acd5-02b9cc79.sandbox.novita.ai/auth/google/callback`. Scopes will be `gmail.readonly` (to ingest threads) and, only if you later want ReplyIQ to create Gmail *drafts* (still never send), `gmail.compose`. The route exists already and returns 501 until the integration is built; it will need `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` secrets.

## Local development

```bash
sudo service postgresql start                       # sandbox has PostgreSQL 17
export DATABASE_URL=postgres://replyiq:replyiq_dev@localhost:5432/replyiq
npm run db:reset                                    # schema + demo cases
SEED_MANAGER_PASSWORD=... SEED_AGENT_PASSWORD=... node scripts/seed-users.mjs
cp .dev.vars.example .dev.vars                      # fill DATABASE_URL, OPENAI_API_KEY
npm run build && pm2 start ecosystem.config.cjs
```

## Not yet implemented

- Gmail ingestion (new emails → cases/threads)
- Password-reset-by-email, 2FA
- Analytics / reporting on outcomes
- Attachments (photos) on cases

- **Platform**: Cloudflare Pages · **Status**: sandbox, awaiting production secrets · **Last updated**: 2026-10-11
