# Bond Portfolio Tracker — BondScanner

Separate project from External bonds holdings (external-payout.vercel.app), started from its code.
Users add the bonds they hold outside BondScanner and track their **portfolio, payouts, maturity and a portfolio report**.

- Live: https://bond-portfolio-tracker.vercel.app/bond-portfolio (Vercel project `bond-portfolio-tracker`, its own Neon database)
- Bond directory: filled from bondscanner.com's live bonds (`POST /v1/external-holdings/admin/bond-directory/sync-bondscanner`,
  header `x-admin-token`), refreshed every day at 06:00 IST by Vercel Cron (`/v1/external-holdings/cron/sync-bondscanner`, `CRON_SECRET`).
  Payouts before the first one bondscanner.com lists are added from the bond's terms back to the issue date.
  When the real directory (Deridata) is available, upload it with `POST /admin/bond-directory` (CSV/xlsx) or add a provider.
- Bonds not in the directory are saved as "Details awaited" and pick up payouts once the directory has them.
- Local: `scripts/dev-api.ps1` (API on :4020) and `scripts/dev-web.ps1` (page on :5174/bond-portfolio).

---

# External Holdings — BondScanner

Track bonds bought on **any** platform next to bonds bought on BondScanner:

1. **One consolidated view** of every bond portfolio (BondScanner + any number of external portfolios).
2. **Payout calendar and reminders** — day before, on the day, a "did it arrive?" nudge, and a 30-day maturity heads-up.
3. **One place for the whole portfolio** — rating mix, issuer concentration, maturity ladder, and a financial-year interest statement for tax filing.

Users add holdings by uploading a CDSL/NSDL CAS PDF, a broker/platform Excel or CSV, a screenshot, or by typing ISIN + units.

> Status: feature-complete and tested against **fictional fixture bonds**. Bond data adapters for SNAPE, Horizon and Deridata are written but need real table/endpoint names once access is granted — see [`docs/DATA_ACCESS.md`](docs/DATA_ACCESS.md).

## Repo layout

```
packages/core     Pure TypeScript domain engine (no I/O). Cash flows, SEBI holiday rules,
                  summaries, XIRR, duplicate detection, reminder planning. 28 unit tests.
apps/api          Fastify + Postgres service. Imports, parsers, bond data adapters,
                  reminder worker + outbox. 20 end-to-end tests (embedded Postgres).
apps/web          React + Vite front end in the BondScanner design system.
                  `build:demo` makes a single-file, no-backend demo for stakeholders.
docs/             PRD, architecture, data access checklist, Superset SQL, rollout plan.
```

## Run it locally (no external access needed)

```bash
npm install
npm test                      # 67 tests: core + API
npm run seed -w apps/api      # loads 2026 market holidays into the embedded DB
npm run dev:api               # http://localhost:4010  (embedded PGlite DB, fixture bonds)
VITE_DEV_USER_ID=demo-1 npm run dev -w apps/web   # http://localhost:5173/external-payout
npm run build:demo            # apps/web/dist-demo/index.html — self-contained demo
```

## Going to staging / production

> Developer handoff: start with **`PR_DESCRIPTION.md`** (what's in the PR, how to review) and **`docs/DEPLOY_CHECKLIST.md`** (what must be filled in before production).

1. Fill in `apps/api/.env` from `.env.example` (real `DATABASE_URL`, `SNAPE_DATABASE_URL`, Deridata key, gateway secret, notification webhook).
2. Confirm SNAPE / Horizon / Deridata field mappings (only three files change — see `docs/DATA_ACCESS.md`).
3. `npm run migrate -w apps/api` against the app database, then `npm run seed -w apps/api`.
4. Deploy the API container (`apps/api/Dockerfile`), and two scheduled jobs:
   - `npm run worker -w apps/api -- sync` every 6 hours, after the Deridata → SNAPE sync (refreshes bond terms, releases "Notify me" bonds and alerts their owners)
   - `npm run worker -w apps/api -- plan` daily at 00:30 IST (`30 19 * * *` UTC)
   - `npm run worker -w apps/api -- drain` every 5 minutes
5. Mount the web screens in the BondScanner app under the Portfolio → Holdings tab (or port the screens to the mobile app — the API is the contract).
6. Roll out behind `EH_ROLLOUT_USERS` — see `docs/ROLLOUT.md`.

## Agreed flow (v5, 18 Nov 2026)

1. **Holdings page** (unchanged) → CTA card below the holdings list → Add page (or the External Holdings page if the user already has external holdings).
2. **Add your holdings**: upload first (up to 5 files, PDF password per file), then an **"Add manually"** toggle: ISIN, quantity, coupon rate, maturity date (+ interest frequency and face value, needed to place and size payouts). If the ISIN is in our data, its details are shown instead of asked. Typed details are verified and replaced automatically once Deridata has the bond. Consent tick box + "Read my holdings".
3. **Confirm your holdings**: matched bonds are fine; unmatched bonds offer **Notify me** (told once data arrives) or **Add details** (same fields as manual, missing ones highlighted); locked PDFs unlock here → Confirm.
4. **Wow screen** for ~2.5 s, then automatically →
5. **External Holdings page**: overview, investments, report card, next 30 days, and an **"Add another holding"** CTA.

**Mobile note:** file pickers open only on a direct tap of a real `<input type=file>` (we wrap it in a `<label>`). If the screens run inside an Android WebView, the app must implement `WebChromeClient.onShowFileChooser`, otherwise no picker opens.

### Someone else's holdings — v2
Not part of v1 (decided 18 Nov 2026). The code is in place behind `EH_OWNERSHIP_CHECK=true` (off by default): PAN warning on the Confirm screen, "family member's, with permission" confirmation, Family tag, masked-PAN audit.

## Key product rules (encoded in `packages/core`)

- Coupon on a weekend/holiday → paid **next** working day, amount unchanged. Redemption on a holiday → paid **previous** working day with interest to that day (SEBI convention for listed NCDs).
- Interest uses ACT/ACT (SEBI) unless the vendor says 30/360 or equal coupons. Vendor-published cash flows always win.
- Payouts whose **record date** is before the purchase date are excluded.
- External payouts are "received" only when the user marks them. Bonds bought on BondScanner are auto-received.
- Uploaded files are never stored — only a SHA-256 hash (to spot the same file twice). PDF passwords are never stored.
- Shares and mutual funds in a statement are skipped (ISIN structure + Horizon instrument type).
- A new upload that overlaps ≥60% with a saved portfolio offers **Replace** (with a diff) or **Add separately**.
