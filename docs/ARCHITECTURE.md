# Architecture and developer handoff

```
 Mobile / web app ──► API gateway (auth) ──► eh-api (Fastify)  ──► Postgres (eh_* tables)
                                               │   │
                                               │   ├─► BondService: cache eh_bond_master ─► SNAPE (SQL) ─► Deridata (HTTP)
                                               │   ├─► Horizon ISIN list (SQL)
                                               │   └─► Parsers: pdfjs (PDF), exceljs (xlsx), CSV, tesseract (images)
                                               │
 CronJob every 6h ── worker sync (refresh terms, release Notify-me bonds)
 CronJob 00:30 IST ── worker plan ─────────────┘──► eh_notification_outbox ◄── worker drain (5 min) ──► notification service
```

## Packages
- **`packages/core`** — pure functions, no I/O, shared by API, worker and web. Start reading at `schedule.ts` (cash flows), `summary.ts`, `dedupe.ts`, `reminders.ts`.
- **`apps/api`** — `container.ts` wires everything from env vars; `routes.ts` is the HTTP surface; `services/` hold logic; `providers/` hold vendor adapters; `parsers/` read files; `notify/` plans and sends reminders.
- **`apps/web`** — React screens. `api/types.ts` is the client contract; `api/http.ts` talks to the API; `api/demo.ts` is an in-browser fake for the demo build.

## Database (migration `apps/api/migrations/001_external_holdings.sql`)
| Table | Purpose |
|---|---|
| `eh_bond_master` | Cache of bond terms by ISIN (TTL 24h, stale fallback if vendors fail) |
| `eh_market_holidays` | Holiday calendar used for business-day adjustment |
| `eh_consents` | Versioned consent log |
| `eh_portfolios` | External portfolios (soft delete; unique name per user) |
| `eh_holdings` | ISIN + units per portfolio; optional invested amount, purchase date, user-entered terms |
| `eh_imports` | One row per upload/manual session; stores file hash and parsed rows until commit, then clears rows |
| `eh_payout_receipts` | Payouts the user marked received |
| `eh_notification_prefs` | Reminder toggles |
| `eh_notification_outbox` | Planned reminders; unique idempotency key; drained with `FOR UPDATE SKIP LOCKED` |
| `eh_events` | Product analytics events |

The BondScanner-bought portfolio is **not stored** here: it is read live through `InternalHoldingsProvider` (replace the fixture with the real holdings service).

## API (`/v1/external-holdings`, user id from gateway header)
| Method | Path | Notes |
|---|---|---|
| GET | `/status` | consented?, number of external portfolios |
| POST | `/consent` | records current consent version |
| GET | `/overview?scope=all\|bondscanner\|<id>` | summary, portfolios, holdings, overlaps |
| GET | `/payouts?scope&from&to` | events with status |
| POST | `/payouts/received` | `{holdingId, scheduledDate, received}` |
| GET | `/report?scope` | rating mix, issuers, maturity ladder, flags |
| GET | `/tax-statement?fy=2026-27&format=json\|csv` | |
| GET | `/bonds/search?q=` | ISIN / name search |
| POST | `/imports` | multipart, up to 5 `file` parts + `password_<index>` → `{importId, files:[{filename,status,message}], rows, skipped, statementDate}`. Each file succeeds or fails on its own |
| POST | `/imports/manual` | `{rows:[{isin, units}]}` → draft |
| GET | `/imports/pending` | latest unsaved import (7 days) for "Continue where you left off" |
| POST | `/imports/:id/review` | `{rows, replacePortfolioId?}` → `{rows (with alreadyIn), committable, match (diff, names, olderThanSaved), notices}`; saves the draft |
| POST | `/imports/:id/commit` | `{rows, mode: new\|replace\|add_new_only, portfolioId?, soldIsins?}`; rows may carry `notify:true` |
| DELETE | `/imports/:id` | discard |
| PATCH/DELETE | `/portfolios/:id` | rename / delete |
| PATCH/DELETE | `/portfolios/:id/holdings/:isin` | units / remove |
| GET/PUT | `/notification-prefs` | |

Errors: `{error: code, message}` with user-facing messages. Header `x-eh-today: YYYY-MM-DD` lets QA time-travel outside production.

## Integration points to finish (all marked `TODO` or `CONFIRM BEFORE USE`)
1. `providers/snape.ts`, `providers/horizon.ts`, `providers/deridata.ts` — real names (see DATA_ACCESS.md).
2. `container.ts` — replace `FixtureInternalHoldings` with the real BondScanner holdings source.
3. `notify/channels.ts` — `WebhookSender` payload to match the notification service; register templates `external_holdings.payout_tomorrow|payout_today|confirm_received|maturity_30d`.
4. Gateway — forward user id in `x-user-id` and `x-gateway-secret`.
5. Mobile app — the web screens are the reference implementation and the design; port to the app's stack or embed as a webview. If embedded in an Android WebView, implement `WebChromeClient.onShowFileChooser` (and on iOS WKWebView file inputs work by default), or the upload button will do nothing.
6. Malware scanning of uploads if the platform requires it (files are processed in memory and discarded).

## Testing
`npm test` runs 48 tests: core engine rules (dates, ACT/ACT, holidays, zero coupon, amortising, record dates, XIRR, dedupe, reminders) and API end-to-end on embedded Postgres (auth, consent, CSV/Excel/PDF imports, duplicate replace, received marks, tax CSV, reminders idempotency, vendor adapter mapping). Add real anonymised statements to `apps/api/test/fixtures/` as they arrive and assert expected rows.

## Security and privacy
- No file persisted; only SHA-256. PDF password used once in memory.
- All queries scoped by user id; cross-user access returns 404 (tested).
- Logs redact auth headers; do not log parsed rows.
- Consent versioned; bump `CONSENT_VERSION` to re-ask after copy changes.
