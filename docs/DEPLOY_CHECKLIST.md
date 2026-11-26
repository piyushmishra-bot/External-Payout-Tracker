# Deploy checklist — External Holdings

Everything in the code runs today on fixtures (tests: 35 core + 29 API). Production needs the items below.
Owner column: **Dev** = BondScanner developer, **PM** = product, **Data** = data/infra team, **Legal** = compliance.

## A. Must have before production
| # | Item | Where in code | Owner |
|---|---|---|---|
| 1 | App Postgres `DATABASE_URL`; run `npm run migrate -w apps/api` (001–005) | `apps/api/migrations` | Dev |
| 2 | SNAPE read-only URL + confirm column mapping for bond terms | `apps/api/src/providers/snape.ts` (SQL marked `TODO(BondScanner)`) | Data + Dev |
| 3 | Horizon ISIN list read-only URL + table/column names | `apps/api/src/providers/horizon.ts` | Data + Dev |
| 4 | Deridata base URL + API key, confirm response field names | `apps/api/src/providers/deridata.ts` | Dev |
| 5 | *(v2 only — skip for v1)* KYC PAN lookup `KYC_PAN_URL` / `KYC_TOKEN`, used only when `EH_OWNERSHIP_CHECK=true` | `apps/api/src/providers/kyc.ts` | Dev |
| 6 | User's own BondScanner holdings provider (only if `EH_INCLUDE_BONDSCANNER=true`) | `apps/api/src/container.ts` `TODO(BondScanner)` | Dev |
| 7 | Gateway auth: API trusts `USER_ID_HEADER` only when `GATEWAY_SECRET` matches | `apps/api/src/server.ts` | Dev |
| 8 | Notification webhook — handle kinds `payout_*`, `bond_available` and `details_needed` (deep link `bondscanner://holdings?tab=external&details=<id>` must open External holdings with Add details) (`NOTIFY_WEBHOOK_URL`, `NOTIFY_WEBHOOK_TOKEN`) wired to the push/email service | `apps/api/src/notify/channels.ts` | Dev |
| 9 | Scheduled jobs: `worker -- sync` every 6 h (after Deridata→SNAPE cron), `worker -- plan` daily 00:30 IST, `worker -- drain` every 5 min | `apps/api/src/notify/worker.ts` | Dev |
| 10 | Mount web screens under Portfolio → Holdings (CTA below investments), or port screens to the app; Android WebView needs `WebChromeClient.onShowFileChooser` for uploads | `apps/web/src/screens/*` | Dev |
| 11 | 2027 NSE holiday list when published (mid-December) | `packages/core/src/holidays` | Dev |
| 12 | Compliance sign-off: consent checkbox on Confirm ("I agree to the Terms and Privacy Policy, and allow BondScanner to keep these holdings to show payouts and send reminders") and the "What we keep" sheet — bump `CONSENT_VERSION` whenever this copy changes; check that bondscanner.com Terms/Privacy cover External Holdings; notification copy, disclaimers (family-holdings wording and masked-PAN storage only for v2) | `apps/web/src/screens/AddFlow.tsx`, `docs/PRD.md` | PM + Legal |

## B. Before turning it on for everyone
- [ ] `EH_ROLLOUT_USERS` = internal team first (see `docs/ROLLOUT.md`)
- [ ] Run 15–20 real (anonymised) CAS/broker statements through staging; add as fixtures
- [ ] Superset dashboard (`docs/sql/04_adoption_dashboard.sql`)
- [ ] Alert on `eh_notification_outbox` failures > 1%/day
- [ ] Support macro: "my payout date looks wrong"
- [ ] Confirm sector field names in SNAPE (`b.sector`) and Deridata (`sector`/`industry`) for the report's sector donut

## C. Verify after deploy (staging, then prod)
1. `GET /health` returns ok.
2. Upload own CAS → no ownership prompt → saved as "My holdings".
3. Upload a statement in another person's name → saves normally, no ownership step, no PAN stored (v1).
4. Open Portfolio report → summary cards, three donuts, payout chart, holding breakdown load.
5. Unknown ISIN + quantity → saved as Details awaited; after 4 `sync` runs with no data, the "We couldn't find details" push arrives and opens Add details; when data appears, the "now verified" push arrives.
6. Delete a holding → its reminders disappear from the outbox.
