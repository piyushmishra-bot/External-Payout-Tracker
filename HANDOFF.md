# External Holdings — handoff (state as of 18 Nov 2026)

Read this first. It replaces the chat history: every decision made so far is listed below.

- **Repo:** https://github.com/piyushmishra-bot/external-holdings (branch `main`)
- **What's in the PR / how to review:** `PR_DESCRIPTION.md`
- **What must be filled in before production:** `docs/DEPLOY_CHECKLIST.md`
- **Edge cases (all rows of the Edge Cases sheet, with tests):** `docs/EDGE_CASES.md`
- **Product spec:** `docs/PRD.md` · **Architecture:** `docs/ARCHITECTURE.md` · **Data access:** `docs/DATA_ACCESS.md`
- **Live demo (no backend needed):** `npm run build:demo` → `apps/web/dist-demo/index.html`

## Run it locally (needs Git and Node 20+)

Windows, if missing: `winget install Git.Git` and `winget install OpenJS.NodeJS.LTS`, then reopen the terminal.

```bash
git clone https://github.com/piyushmishra-bot/external-holdings
cd external-holdings
npm install
npm test                                          # 67 tests (35 core + 32 API)
npm run seed -w apps/api
npm run dev:api                                   # API  http://localhost:4010 (embedded DB, fixture bonds)
VITE_DEV_USER_ID=demo-1 npm run dev -w apps/web   # App  http://localhost:5173
```
(On Windows PowerShell: `$env:VITE_DEV_USER_ID="demo-1"; npm run dev -w apps/web`.)

## Agreed flow
1. Holdings tab → card **below Investments** → External holdings (empty → straight to Add).
2. **Add page:** upload first (PDF incl. password, Excel/CSV, screenshot; up to 5 files) + **Add manually** toggle.
3. **Add manually fields (only these):** ISIN, Date of investment, Units, Invested amount, Yield. Bond terms come from the ISIN.
4. **Confirm your holdings:** mismatches shown at the bottom; bonds not in our data become **Details awaited** automatically (no action needed); optional **Add details** = the same five fields. Small **Terms / Privacy consent checkbox** above Confirm (shown once per `CONSENT_VERSION`).
5. **Success screen** ~2.5 s.
6. **External holdings:** Overview card, Investments per holding (⋮ Rename/Delete), **Add another holding**, Payout calendar, Portfolio report. Tap a bond → **Bond details** (investment details, investment entry, upcoming/past payouts).

## Decisions (do not re-ask)
- Design follows live bondscanner.com (checked signed-in, mobile and desktop): header, ticker, Explore/Holdings/Orders/Watchlist tabs, 1200px two-column desktop; m-web uses the mobile header. Web layout from 768px, two columns from 1024px.
- Name the external payouts page **Payout calendar** (not "Payout details", which is BondScanner's own).
- No name field when saving: auto "My holdings", "My holdings 2", renamable. PDF password field kept.
- External totals include external bonds only (never BondScanner holdings).
- Odd-unit hints never block. Extra reminders (confirm nudge, maturity heads-up) are fine.
- No tax statement, no reminder-settings screen.
- **Bonds not in our data:** saved as Details awaited; re-checked on every 6-hourly sync; if still missing after `EH_ASK_DETAILS_AFTER_SYNCS` (default 4 ≈ 1 day) → one push "Complete your investment details for …" opening Add details.
- **Someone else's statement (PAN check): NOT in v1.** Built behind `EH_OWNERSHIP_CHECK=true`, off by default; planned for v2.
- **Portfolio report** follows the family-report layout: title, holding picker + email/download/help, 4 summary cards, donuts by holding/sector/rating, Payouts by month (stacked bars), Holding breakdown. External holdings only.
- Copy must be professional (no casual phrasing).

## Open items
- Load the bondscanner.com **Explore list** (ISIN, coupon, maturity, rating, frequency) as local test data — not done yet.
- Production wiring (see `docs/DEPLOY_CHECKLIST.md`): SNAPE / Horizon / Deridata mappings (incl. `sector`), gateway auth, notification webhook (kinds `payout_*`, `bond_available`, `details_needed`), scheduled jobs, compliance sign-off on consent copy.
- Developer raises the PR and deploys; migrations 001–005 run in order.
