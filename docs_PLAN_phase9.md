# Phase 9 plan — tone filter, bulk actions, SP-API orders, review requests
(Approved: pending. Written 2026-10-12. Sources: developer-docs.amazon.com, checked today.)

## 1. Tone filter (Inbox)
- Multi-select chips above the ticket list: Angry · Dispute · Frustrated · Worried · Neutral · Happy · (No label).
- Client-side on the already-loaded list (list is small); persisted in localStorage; combines with status filter + search.
- No API change.

## 2. Bulk actions (Inbox)
- Checkbox per ticket + "select all visible". Action bar appears when ≥1 selected:
  Mark resolved · Set status (open / awaiting customer) · Assign to… · Change tone… · Archive (managers only).
- NEW `POST /api/cases/bulk` { ids:[], action, value } → { done:[ids], skipped:[{id, case_ref, reason}] }.
- Bulk RESOLVE skips a case if ANY of: open A-to-Z event, open chargeback event, battery_flag, a draft with
  status='draft' AND needs_manager=true. Skips are returned and shown in a result panel ("3 resolved, 2 skipped: …").
- Archive requires manager (server-enforced). Nothing in the bulk endpoint can send email — send stays only on
  POST /api/drafts/:id/send with its existing six gates.
- Max 200 ids per call; one transaction per call.

## 3. SP-API order details (private self-authorised app)
- API version: Orders **v2026-01-01** (v0 is deprecated as of the current docs). Endpoint (EU):
  `GET https://sellingpartnerapi-eu.amazon.com/orders/2026-01-01/orders/{orderId}?includedData=FULFILLMENT,PACKAGES,PROCEEDS`
  Rate: 0.5 req/s, burst 30. Marketplace UK = `A1F83G8C2ARO7P`.
- Fields → case: createdTime (order date), fulfillment.fulfillmentStatus, orderItems[] (title/asin/sku/qty/condition/unitPrice),
  packages[] (carrier, trackingNumber, shipTime, packageStatus.status e.g. DELIVERED) → tracking_number, carrier,
  delivery_date (from package status DELIVERED time when present; else deliverByWindow.latest as "estimated").
- includedData NEVER includes BUYER or RECIPIENT (that is the PII). Roles requested in the app: **Inventory and Order
  Tracking** + **Buyer Solicitation** only. No "Direct-to-Consumer Shipping (Restricted)" etc.
- Auth: LWA refresh-token exchange at https://api.amazon.com/auth/o2/token; access token cached ~55 min in D1/PG.
  Secrets: SPAPI_LWA_CLIENT_ID, SPAPI_LWA_CLIENT_SECRET, SPAPI_REFRESH_TOKEN (wrangler secret put). No AWS SigV4 needed
  (removed from SP-API in 2023 — LWA bearer token only).
- UI: "Fetch from Amazon" button on the case Order panel; shows a diff (current vs Amazon) and fills empty fields;
  never overwrites a value a member of staff typed, unless they click "Replace". Also runs automatically once per case
  on first open if order_id is set and spapi_synced_at is null (one call, within rate limit).
- Tables: orders_cache (order_id PK, json, fetched_at) ; cases.spapi_synced_at.

## 4. Review requests — Solicitations API only
- `GET /solicitations/v1/orders/{orderId}?marketplaceIds=A1F83G8C2ARO7P` (1 req/s, burst 5) → if
  `productReviewAndSellerFeedback` action is listed → `POST /solicitations/v1/orders/{orderId}/solicitations/
  productReviewAndSellerFeedback?marketplaceIds=…` (same limits). Second attempt for an order returns 403 (Amazon's own once-per-order guard).
- Our rule (identical for every order, never tone/outcome based): eligible when delivery_date + 7 days ≤ now AND now ≤ delivery_date + 30 days.
  Before 7 days the button is disabled with the date it becomes available; after 30 days it is hidden.
- Once per order: review_requests table (order_id UNIQUE, case_id, requested_by, requested_at, amazon_result). Logged as an
  'event'-kind message on the case ("Review request sent via Amazon").
- Phase 1 = manual button on the case screen. Phase 2 (later, separate approval) = cron that calls the same function for every
  order hitting day 7, still eligibility-checked, still once.
- reply_instructions.md unchanged; serverChecks still FAILS any draft that mentions reviews/feedback.

## Seller Central setup steps (user)
1. Seller Central → Apps and Services → Develop Apps. If prompted, complete the Developer Profile:
   Data Access = "Private Developer", Roles = Inventory and Order Tracking + Buyer Solicitation, use case = "customer-service
   tool: read order status/tracking for our own orders; send Amazon review requests for eligible delivered orders".
   Wait for Amazon's approval case (email) — can take days.
2. Develop Apps → Add new app client: name "ReplyIQ", API type SP-API, Sellers, roles as above. Save.
3. Row for the app → "View" under LWA credentials → copy Client ID and Client Secret.
4. Same row → "Authorize" → "Authorize app" → copy the Refresh Token (shown once).
5. Send me nothing by chat. Set three Worker secrets yourself (Cloudflare dashboard → Workers → replyiq → Settings →
   Variables & Secrets): SPAPI_LWA_CLIENT_ID, SPAPI_LWA_CLIENT_SECRET, SPAPI_REFRESH_TOKEN. Then press "Test connection" on the
   ReplyIQ Settings page.
