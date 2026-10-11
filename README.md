# ReplyIQ

AI-assisted reply drafting for **Saigates Ltd** Amazon UK customer service.

- **Goal**: help agents answer Amazon UK customer messages inside the 24-hour reply window, with AI-generated drafts that agents always review, edit and approve. **Nothing is ever sent to customers automatically.**
- **Tech stack**: Hono (TypeScript) on Cloudflare Pages/Workers · PostgreSQL via `postgres` (postgres.js) · Tailwind CSS + vanilla JS frontend
- **Sandbox URL**: https://3000-id2nlba4e4s5y3pr1acd5-02b9cc79.sandbox.novita.ai

## Phase 1 — delivered (this build)

| Feature | Status |
|---|---|
| Case queue sorted by reply deadline (last customer message + 24h) with overdue / due-soon highlighting and status filters | ✅ |
| Case screen: full email thread (inbound/outbound) | ✅ |
| Agent-filled fields with auto-save: order ID, device model, delivery date, refund issued (Y/N), A-to-Z open (Y/N), in stock (Y/N), approved repair price, tracking number, carrier | ✅ |
| Case status (open / awaiting customer / resolved) | ✅ |
| PostgreSQL schema incl. `drafts` table ready for phase 2 | ✅ |
| "Generate draft" button (placeholder, disabled) | ⏳ phase 2 |

## Not yet implemented (phase 2)

1. **Generate draft** → server-side `POST /api/cases/:id/drafts` calls OpenAI (`gpt-5.5`) using `reply_instructions.md` as the system prompt; returns draft text, staff notes and a PASS/FAIL check.
2. Draft editor with **Approve** action (stores `status='approved'`, `approved_by`, `approved_at`).
3. Agent login / names for the approval audit trail.
4. Inbound email ingestion (new messages → new cases / thread updates).

> ⚠️ `reply_instructions.md` in this repo is a **placeholder**. The real file was not supplied — please provide it before phase 2.

## Privacy & security design

- `OPENAI_API_KEY` is a server-side secret (`.dev.vars` locally, `wrangler pages secret put` in production). It is never shipped to the browser.
- The schema separates `customer_first_name` from PII columns (`customer_last_name`, `customer_email`, `customer_phone`, `customer_address`). The phase-2 OpenAI payload will be built from an explicit allow-list: first name, thread bodies, and the agent-filled case fields only.
- Agents see full customer details in the UI; the AI never does.

## API

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Liveness + DB config check |
| GET | `/api/cases?status=active\|open\|awaiting_customer\|resolved\|all` | Case list ordered by `reply_deadline` ASC (default `active` = not resolved) |
| GET | `/api/cases/:id` | Case + `messages[]` + `drafts[]` |
| PATCH | `/api/cases/:id` | Update any of: `status, order_id, device_model, delivery_date (YYYY-MM-DD), refund_issued, a_to_z_open, in_stock (bool/null), approved_repair_price, tracking_number, carrier`. Returns 422 with per-field errors on bad input. |

UI routes: `/` (queue), `/cases/:id` (case screen).

## Data model (PostgreSQL)

- **cases** — case metadata, customer identity (first name separated from PII), agent fields, `last_customer_message_at`. `reply_deadline` is derived as `last_customer_message_at + 24h`.
- **messages** — thread entries (`direction` inbound/outbound, `sender`, `body`, `sent_at`).
- **drafts** — AI drafts: `draft_text`, `staff_notes`, `check_result` (PASS/FAIL), `check_details`, `model`, `status` (draft/approved), approval audit fields.

Schema: `db/schema.sql` · Sample data: `db/seed.sql`

## Local development

```bash
# 1. Postgres (sandbox has PostgreSQL 17 installed locally)
sudo service postgresql start
export DATABASE_URL=postgres://replyiq:replyiq_dev@localhost:5432/replyiq
npm run db:reset            # schema + seed

# 2. Secrets
cp .dev.vars.example .dev.vars   # set DATABASE_URL (and OPENAI_API_KEY for phase 2)

# 3. Build & run
npm run build
pm2 start ecosystem.config.cjs
curl http://localhost:3000/api/health
```

## Deployment notes

Cloudflare Workers cannot reach a Postgres server on `localhost`. For production, point `DATABASE_URL` at a hosted Postgres that accepts connections from the edge (Neon, Supabase, or Cloudflare Hyperdrive in front of your own server) and set it with `wrangler pages secret put DATABASE_URL`. The app code is unchanged.

- **Platform**: Cloudflare Pages
- **Status**: Sandbox only (not yet deployed)
- **Last updated**: 2026-10-11
