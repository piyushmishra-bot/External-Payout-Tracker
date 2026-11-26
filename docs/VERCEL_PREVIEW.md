# Shared preview on Vercel

**Link:** https://external-payout.vercel.app (opens `/external-payout`)

Vercel project `external-payout` (team product-management17), connected to this GitHub repository. Data is in a Neon Postgres database (`neon-emerald-kettle`) added through Vercel, which sets `DATABASE_URL`.

## How it is built
`npm run build:vercel` (`scripts/build-vercel.mjs`) writes Vercel's prebuilt output to `.vercel/output`:
- `static/` — the web page, built with `VITE_PREVIEW_USERS=1`: each browser gets its own random test account (`preview-xxxxxxxx`, kept in localStorage), so visitors' data never mixes.
- `functions/api.func` — the API as one bundled Node function (`apps/api/src/vercel.ts`) with the SQL migrations next to it. Migrations, including the 2026 market holidays (`008_…`), run on the first request.
- Routes: `/v1/*` → API; `/` → `/external-payout`; `/external-payout/*` → the page.

`vercel.json` makes Vercel run the same build for Git deployments.

## Settings on the Vercel project
| Name | Value |
|---|---|
| `DATABASE_URL` (and other `POSTGRES_*`/`PG*`) | set by the Neon integration |
| `BOND_PROVIDERS` | `directory` (no fixture bonds) |
| `OCR_ENGINE` | `none` |
| `PG_POOL_MAX` | `3` |
| `EH_ADMIN_TOKEN` | random secret; the only readable copy is in your local `.env.local` (gitignored) |

`node scripts/vercel-env.mjs` sets these (except the Neon ones).

## Deploy
```powershell
npm run build:vercel
npx vercel@latest deploy --prebuilt --prod
```
Pushing to `main` also deploys (Vercel builds it with `vercel.json`).

## Refresh the bond directory (bondscanner.com live bonds)
About 45 seconds; run whenever new bonds should appear:
```powershell
node --env-file=.env.local -e "fetch('https://external-payout.vercel.app/v1/external-holdings/admin/bond-directory/sync-bondscanner',{method:'POST',headers:{'x-admin-token':process.env.EH_ADMIN_TOKEN}}).then(r=>r.json()).then(b=>console.log(b.saved,'bonds saved'))"
```

## Limits of the preview
- No BondScanner login: the API trusts the browser's test-account id. Fine for a preview; production uses the gateway (`GATEWAY_SECRET`, `USER_ID_HEADER`).
- Only bonds listed on bondscanner.com have terms; others show "Fetching details" until Deridata / a bond directory is connected.
- Screenshot and PDF statement reading are not included in the preview build (the template upload does not need them).

## Who is using the tool, and the admin page

- Data lives in Neon (`DATABASE_URL`). Supabase also works if ever needed: connect it with the `SUPABASE_` prefix and the API uses `SUPABASE_POSTGRES_URL`; `EH_DATABASE_URL` overrides both.
- No login or form: people arrive straight from bondscanner.com (like /payout-detector). Each browser is an anonymous visitor; visits are logged at most every 30 minutes (`GET /profile`). Inside bondscanner.com the gateway can pass the logged-in user's name and email (`x-user-name`, `x-user-email`, trusted only with `GATEWAY_SECRET`), stored in `eh_users`. Opening the upload page and downloading the template are logged from the browser (`POST /events`).
- **Admin page:** https://external-payout.vercel.app/external-payout/admin — enter the admin key (`EH_ADMIN_TOKEN`, kept in `.env.local` on the dev PC and in Vercel). Shows visitors, people active in the last 7 days, adoption (people with holdings), ISINs and amount tracked, the adoption funnel (visited → opened upload → downloaded template → uploaded → saved → still has holdings), active people per day, every person with their numbers, and recent activity. Data: `GET /admin/stats?days=7|30|90` with header `x-admin-token`.
- The same numbers as SQL views (schema `eh_admin`: `users`, `activity`, `daily_usage`) for the Neon console's Tables / SQL Editor.
- Migration `011_users_and_tracking.sql` also turns on row level security on every table (only matters on Supabase, harmless elsewhere).

## Team alert when a visitor sends a file

When someone uses "Have it in another format? We'll add it for you", the API alerts the team with the file name and size, the visitor (name and email when known), their note, and a link to the admin page. The file is not attached; download it from the admin page.

Add these in Vercel → project external-payout → Settings → Environment Variables (Production), then redeploy:

- **Slack:** `ALERT_SLACK_WEBHOOK_URL`, from Slack → Apps → Incoming Webhooks → Add to the team channel.
- **Email (via Resend):** `RESEND_API_KEY` (resend.com → API Keys) and `ALERT_EMAIL_TO` (comma-separated). Until a sending domain is verified in Resend, emails go only to the Resend account's own address; after verifying bondscanner.com, set `ALERT_EMAIL_FROM` (e.g. `BondScanner Holdings <alerts@bondscanner.com>`).

Either, both or neither can be set. A failed alert never blocks the visitor's upload.

## Adding a visitor's holdings from a file they sent

Admin page → **Files sent by visitors**:
1. Click the file name to download it and read the bonds.
2. **Add holdings** → download the Excel template, fill one row per bond (ISIN, Issuer name, Units, Investment amount, Date of investment, Yield), upload it, check the preview, **Add N bonds**. The bonds go into that visitor's holdings (`POST /admin/assisted/:id/holdings`) and the request is marked added; the visitor sees "Your holdings are updated".
3. **Delete file** to free space (`DELETE /admin/assisted/:id/file`). Only the file is removed; the request row (name, dates, bonds added) stays.
