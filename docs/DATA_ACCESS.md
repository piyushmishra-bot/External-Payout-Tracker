# Data access checklist

What to ask for, who to ask, and exactly what changes in code once you have it.

| # | Access | Ask whom | Why | Unblocks |
|---|---|---|---|---|
| 1 | **Superset** login with read on SNAPE + Horizon schemas | Data / analytics team | Discover real table and column names; build adoption dashboards | Steps 2–3 below |
| 2 | **SNAPE** read-only DB user (`SELECT` only) for the API service | Data engineering / DBA | Primary source for bond terms and cash flows | `BOND_PROVIDERS=snape` |
| 3 | **Horizon** ISIN list read-only DB user | Data engineering / DBA | Skip shares/MFs, distinguish "unknown ISIN" from "known ISIN, no terms" | `HORIZON_DATABASE_URL` |
| 4 | **Deridata API** docs + a staging key, plus rate limits and per-call cost | Vendor manager / whoever owns the Deridata contract | Fallback for newly listed ISINs not yet in SNAPE | `BOND_PROVIDERS=snape,deridata` |
| 5 | **GitHub** repo (new repo or folder in the main monorepo) and a reviewer | Engineering manager | PR + CI + deploy | Handoff |
| 6 | **Notification service** endpoint (push, email, WhatsApp) and template approval process | Growth / CRM team | Send reminders | `NOTIFY_WEBHOOK_URL` |
| 7 | **BondScanner holdings source** — how to read a user's own bond holdings (service or table) | Backend lead | "Bought on BondScanner" portfolio | Replace `FixtureInternalHoldings` in `apps/api/src/container.ts` |
| 8 | **Auth** — how the gateway forwards the verified user id | Backend lead / platform | Secure every endpoint | `USER_ID_HEADER`, `GATEWAY_SECRET` |
| 9 | **Sample statements** — 5–10 anonymised CAS PDFs (NSDL + CDSL), 3–5 platform exports (Wint Wealth, GoldenPi, Grip, Jiraaf, Zerodha bonds), 5 app screenshots | Ops / your own accounts with PII redacted | Tune parsers against real layouts | Parser accuracy |
| 10 | **Compliance sign-off** on consent copy and data retention (DPDP Act 2023) | Compliance / legal | Launch | Production |

## Exactly what to edit once you have SNAPE / Horizon / Deridata

Only three files hold vendor-specific names. Nothing else changes.

1. `apps/api/src/providers/snape.ts` → `SNAPE_SQL` (two queries) and `mapRow()`.
2. `apps/api/src/providers/horizon.ts` → `HORIZON_SQL` and `normalise()`.
3. `apps/api/src/providers/deridata.ts` → `PATHS`, the auth header, and `toRow()`.

The fields the engine needs per ISIN:

| Field | Required | Notes |
|---|---|---|
| ISIN | yes | |
| Issuer name | yes | Display name is built as "Issuer Mon ’YY" |
| Face value per unit | yes | Many retail NCDs are ₹1,000; private placements ₹1,00,000 |
| Coupon rate (% p.a.) | yes | 0 for zero-coupon |
| Interest frequency | yes | Monthly / Quarterly / Half-yearly / Annual / Cumulative |
| Maturity date | yes | |
| Allotment / issue date | strongly preferred | Needed for the first broken period |
| Day count convention | preferred | Defaults to ACT/ACT |
| Record date offset (days) | preferred | Defaults to 15 |
| Redemption amount | for zero-coupon / cumulative | |
| Staggered redemption schedule | for amortising bonds | |
| **Cash flow schedule per unit** | **best of all** | If SNAPE/Deridata has it, the engine uses it as is and skips generation |
| Credit rating + agency | preferred | For the portfolio report |
| Coupon type (fixed / floating / step-up) | preferred | Floating-rate bonds need the vendor cash flow schedule |

## Superset queries to run on day one

See `docs/sql/`:

- `01_snape_discovery.sql` — find the bond master and cash-flow tables and their columns.
- `02_horizon_discovery.sql` — same for the ISIN list.
- `03_coverage_check.sql` — what share of ISINs held by BondScanner users has full terms (target ≥ 95% before launch).
- `04_adoption_dashboard.sql` — funnel and engagement from `eh_events` once live.

## Market holidays

`apps/api/data/holidays.csv` holds the NSE 2026 trading holiday list (16 weekday closures). Two follow-ups:

- Add 2027 when NSE publishes its circular (usually mid-December).
- Confirm with an issuer/RTA contact whether payout "working days" follow NSE holidays or RBI/bank holidays in Mumbai. Term sheets usually say "business day = a day banks are open in Mumbai". If so, load the RBI list instead. One CSV, no code change.
