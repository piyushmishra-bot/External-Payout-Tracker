# External Holdings: track bonds bought on other apps

## What this adds
Users can add bonds they hold on other platforms (upload CAS/broker statements — PDF incl. password-protected, Excel/CSV, screenshots — or type ISIN, quantity, maturity date, coupon rate) and see them in one place with payout dates and reminders.

**Flow:** Holdings → "Track bonds from other apps" CTA (below investments) → Add (upload, or toggle Add manually) → Confirm your holdings (mismatches, Notify me, Add details with missing fields highlighted, ownership check) → 2–3 s success screen → External Holdings (overview, investments, payouts list/calendar, portfolio report, Add another holding).

## Structure
- `packages/core` — pure TypeScript: payout schedules (SEBI ACT/ACT, holiday shifts, record date), ISIN validation, summaries, dedupe, reminders, ownership (PAN compare/mask).
- `apps/api` — Fastify service + Postgres: imports, holdings, bond terms (cache → SNAPE → Deridata), Horizon ISIN directory, notification worker.
- `apps/web` — React screens on BondScanner's design system; `npm run build:demo` produces a single-file demo with an in-browser backend.
- `docs/` — PRD, architecture, data access, edge cases (all 24 sheet rows + ownership), rollout, deploy checklist, Superset SQL.

## Database
Migrations `001_external_holdings.sql`, `002_edge_cases.sql`, `003_ownership.sql`, `004_details_reminder.sql`, `005_purchase_yield.sql` (all additive, `eh_` prefix; no change to existing tables).

## Web (desktop) and m-web
Web layout from 768px (two columns from 1024px), matched to bondscanner.com: desktop keeps the site header (Bonds / Company, search, account), ticker and Explore / Holdings / Orders / Watchlist tabs on every page, a 1200px container and two columns (content ~770px + 400px side panel). m-web uses the mobile header, sub-page back/help bar and floating search. Type scale: headings 16–18/600, body 13–14, meta 11–12.

## Add manually
Fields: **ISIN, date of investment, units, invested amount, yield**. Bond terms (coupon, maturity, schedule) come from the ISIN. Stored as `acquired_on`, `invested_amount` and `purchase_yield` (migration `005_purchase_yield.sql`).

## Dialogs
Bottom sheet on phones; centred dialog on web. Rendered in a portal so the overlay always covers the whole window.

## Bond details
Tapping a bond opens its page (modelled on BondScanner's holding page): investment details, the investment entry (date, amount, @yield, units) and upcoming/past payouts, each of which can be marked received.

## Bonds we don't have yet
ISIN + quantity is enough. An unknown bond is saved as **Details awaited** (out of totals) with no action from the user; coupon/maturity are optional in Add manually. Each `worker -- sync` (6-hourly) retries it. If it's still missing after `EH_ASK_DETAILS_AFTER_SYNCS` syncs (default 4 ≈ 1 day), one `details_needed` push is sent, deep-linking to `bondscanner://holdings?tab=external&details=<holdingId>`, which opens **Add details** with the same fields as Add manually (date of investment, units, invested amount, yield) via `PUT /holdings/:id/investment`. Bond terms always come from the ISIN; `PUT /holdings/:id/details` (user-entered coupon/maturity) is kept in the API but no longer used by the UI. Migration `004_details_reminder.sql`, `005_purchase_yield.sql`.

## Consent
A small checkbox above **Confirm** on the Confirm screen: agree to the Terms and Privacy Policy and allow BondScanner to keep the holdings for payouts and reminders, with a "What we keep" sheet. Confirm stays disabled until ticked; it is shown once per `CONSENT_VERSION` (now `2026-11-v2`) and stored in `eh_consents` with time, IP and user agent. The server rejects saving without it (403 `consent_required`). Files are read before consent only to show the Confirm screen; nothing is saved until the user confirms.

## Portfolio report
Laid out like the family portfolio report: holding picker with email / download (PDF, CSV) / help, four summary cards, donuts by holding, sector and rating, stacked monthly payout chart (Interest / Principal, by year) and a holding breakdown with bond-level detail. Sector comes from SNAPE/Deridata (`sector` — confirm field names).

## Not in v1: someone else's holdings (v2)
Built but **off** (`EH_OWNERSHIP_CHECK` unset). When off, no PAN is read, compared or stored and the Confirm screen has no ownership step. Turning it on in v2 adds the warning + "family member, with permission" confirmation, Family tags, masked-PAN audit (`eh_ownership_confirmations`, migration 003) and needs `KYC_PAN_URL`.

## How to review / test
```bash
npm ci
npm test            # 35 core + 32 API tests (PGlite, no external services)
npm run typecheck
npm run dev:api & npm run dev:web
npm run build:demo  # apps/web/dist-demo/index.html
```

## Before production
See `docs/DEPLOY_CHECKLIST.md` — data mappings (SNAPE, Horizon, Deridata), KYC PAN endpoint, gateway auth, notification webhook, scheduled jobs, compliance sign-off. All placeholders are marked `TODO(BondScanner)`.

## Rollout
Behind `EH_ROLLOUT_USERS` (team → 5% → everyone), see `docs/ROLLOUT.md`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01KaejS2ZxcyLPDmUoZppSGN
