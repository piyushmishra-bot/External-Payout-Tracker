# PRD — External Holdings (consolidated bond portfolio)

**Owner:** Product (BondScanner) · **Status:** Built, pending data access and staging · **Last updated:** 17 Nov 2026

## Problem
Retail bond investors in India spread holdings across several platforms (BondScanner, Wint Wealth, GoldenPi, Grip, Jiraaf, broker apps, demat directly). Each app shows only its own bonds, so investors cannot answer simple questions: *How much interest am I getting this month? When does my next payout land? How concentrated am I in one issuer?* They track it in spreadsheets, if at all, and miss credits.

## Goals
1. **Consolidated view** — every bond the user holds, on any platform, in one summary.
2. **Payout reminders** — know what arrives and when; get nudged the day before and on the day.
3. **One place for the whole portfolio** — report (rating mix, issuer concentration, maturity ladder) and a tax-ready interest statement.

Business goals: make BondScanner the investor's home screen for bonds; grow tracked AUM; convert maturity proceeds into BondScanner purchases (maturity heads-up links to Explore).

## Non-goals (v1)
- Auto-sync from other platforms or depositories (Account Aggregator / CAS-by-email is v2).
- Live market prices or mark-to-market; we show face value and expected cash flows.
- Verifying credits in the user's bank account (user marks "received").
- Trading external holdings.

## Users and entry points
- Existing BondScanner investors on the Holdings tab: an "Hold bonds on other apps too?" card (empty state) → add flow.
- After the first portfolio: "Add another portfolio", tools list (report, interest statement, reminders), scope chips (All / BondScanner / each portfolio).
- Notifications deep-link into Payout details for the date.

## Flow
Welcome (perks) → Consent (once, versioned) → Add (upload PDF/Excel/CSV/screenshot or type ISIN + units) → Reading (progress) → **Check your holdings** (every row needs an ISIN and units; fix, add term-sheet details, or remove) → duplicate check → Name → Success (expected interest, first payout) → Summary.

Updating: Portfolio → "Update with a newer statement" → same flow → diff sheet (changed / removed / new) → Replace. "Received" marks survive updates.

## Requirements

| # | Requirement | Acceptance |
|---|---|---|
| R1 | Upload CDSL/NSDL CAS PDF, including password-protected | Password prompt with PAN hint; wrong password message; password never stored |
| R2 | Upload Excel (.xlsx) and CSV with any header naming | Detects ISIN / quantity / name / invested columns; falls back to scanning cells |
| R3 | Upload screenshot | OCR; rows marked "Check"; name-only rows get bond suggestions |
| R4 | Type holdings | Search by ISIN or name; ISIN check-digit validation |
| R5 | Skip non-bonds | Shares and mutual funds listed as skipped, never saved |
| R6 | Unknown ISIN | User can add coupon, frequency, maturity, face value; payouts marked "Your details" |
| R7 | Units that look like an amount | "Did you mean N units?" suggestion |
| R8 | Duplicate / newer statement | Same → "Keep what I have"; ≥60% overlap → diff + Replace or Add separately |
| R9 | Consolidated summary | Interest this month, total investment, expected interest, avg coupon (or XIRR when purchase data exists), next payout; per-portfolio filter |
| R10 | Payout details | Bar chart by month (interest / principal), month list, calendar with status dots, per-date sheet |
| R11 | Payout accuracy | SEBI holiday rules; ACT/ACT; record date check; vendor cash flows override |
| R12 | Mark received | Statuses: Upcoming, Due today, Awaiting credit, Not marked received (2+ days), Received |
| R13 | Reminders | T-1 and T-0 at 09:00 IST, T+3 confirm nudge, 30-day maturity heads-up; per-type and per-channel toggles; one message per day when several payouts fall together; never sent twice |
| R14 | Portfolio report | Rating mix, issuers, maturity ladder, plain-language flags (issuer > 25%, > 30% BBB or below) |
| R15 | Interest statement | Per financial year, gross interest + indicative 10% TDS, CSV download |
| R16 | Manage | Rename, edit units, remove bond, delete portfolio (soft delete) |
| R17 | Privacy | Files never stored; consent versioned and logged; user can delete any portfolio |

## Copy and compliance
- Sentence case, plain and exact (BondScanner voice). No "guaranteed" or "assured".
- Show amounts as **before tax**. TDS shown as indicative only.
- Footer note on Holdings: added holdings depend on what the user provides; interest goes to the holder on the record date.
- Consent text reviewed by compliance before launch (DPDP Act 2023: purpose limitation, deletion on request).

## Success metrics
| Metric | Target (90 days after GA) |
|---|---|
| % of active investors who add ≥1 external portfolio | 15% |
| Import success (parsed → created) | ≥ 70% |
| Rows matched with no user edit (PDF/Excel) | ≥ 85% |
| Reminder open rate | ≥ 25% |
| Tracked external face value | ₹ __ Cr (set after week 2) |
| Maturity heads-up → BondScanner purchase within 30 days | ≥ 5% |

Dashboards: `docs/sql/04_adoption_dashboard.sql`. Events: `eh_consent_given`, `eh_import_parsed`, `eh_portfolio_created`, `eh_portfolio_replaced`, `eh_portfolio_deleted`, `eh_payout_marked_received`, `eh_tax_statement`.

## Risks
| Risk | Mitigation |
|---|---|
| Statement layouts vary; parser misreads | Mandatory review screen; low-confidence rows marked "Check"; collect sample statements before launch; track `pct_matched` by parser |
| ISINs missing from SNAPE | Deridata API fallback; user-entered terms; weekly gap report (`03_coverage_check.sql`) |
| Wrong payout dates erode trust | Vendor cash flows preferred; SEBI conventions; holiday calendar maintained yearly; "Your details" label |
| Users double count across portfolios | Overlap warning on summary; "Add separately" warns about double counting |
| Reminder spam | Grouped per day; idempotency keys; per-type toggles |

## v2 ideas
CAS auto-import via email forwarding or Account Aggregator; floating-rate reset handling; post-tax view; family portfolios; share-a-report PDF; WhatsApp bot for "what's my next payout".
