# Edge-case coverage (from the Edge Cases sheet)

Every row is handled in both the API and the screens. "Test" names the automated test in `apps/api/test/api.test.ts`.

| Category | Edge case | Behaviour | Test |
|---|---|---|---|
| Upload | Corrupted or unreadable file | That file fails alone with "We could not read this file…" and a Retry / Go back to fix; other files still go through | reads several files at once |
| Upload | Password-protected PDF | Password field per PDF; "This PDF is locked…" / "That password did not work…"; password never stored | locked PDF asks for the password |
| Upload | Empty statement | "No holdings found in this file." | reads several files at once |
| Upload | Same file uploaded twice | Caught by file hash: "You already added this exact file before, so it was skipped." | the same file uploaded again |
| Extraction | Missing ISIN | Row kept as "Check ISIN" with an input and name-based suggestions | flags invalid ISINs… |
| Extraction | Missing quantity | Row kept as "Units missing" with a units stepper; blocks Confirm | flags invalid ISINs… |
| Extraction | Invalid ISIN | Kept (never dropped), shown as typed, must be fixed or removed | flags invalid ISINs…; keeps OCR-mangled ISINs |
| Extraction | Unknown ISIN | **No action needed** (18 Nov 2026): saved as "Details awaited" with ISIN + quantity, out of totals. Every 6-hourly sync looks it up again; found → updated and the user is told. Still missing after `EH_ASK_DETAILS_AFTER_SYNCS` (default 4 ≈ 1 day) → one push "Complete your investment details for …" that opens Add details (date of investment, units, invested amount, yield — the same fields as Add manually). Bond terms always come from the ISIN. | details awaited… still missing after a day |
| Extraction | Multiple bonds in one statement | All shown; same bond across files has units added | reads several files at once |
| Duplicates | Same ISIN and same quantity | Per row "Already added — Do not add"; whole list identical → "You already added this" | same ISINs and units |
| Duplicates | Same ISIN, different quantity | Shown as Changed in the update sheet; never auto-rejected | partial overlap |
| Duplicates | Same bond via different brokers | Kept as separate holdings | flags invalid ISINs… (overlaps) |
| Duplicates | Partial overlap | "Add only the N new bonds", "Update", or "Add as a separate holding" | partial overlap |
| Portfolio | Bond missing from latest statement | Each missing bond: "Still hold it" (default) or "Sold it"; nothing auto-removed | newer statement… |
| Portfolio | Zero or negative units | Kept as "Units missing" to correct | flags invalid ISINs… |
| Portfolio | Multiple statements, different brokers | Separate holdings, renamable (Zerodha, Dad's portfolio…). *Needs discussion per sheet* | — |
| Ownership | Statement in someone else's name (PAN ≠ user's KYC PAN) | **v1: allowed, no check** (decided 18 Nov 2026). **v2** (built, off by default; `EH_OWNERSHIP_CHECK=true`): allowed with a warning. Confirm screen: "X.pdf is in someone else's name (PAN XXXXX5678K, NAME)". User must tick "It's a family member's and I have their permission" and say whose (Eg. Dad), or Remove this file. Saved as a separate holding tagged Family · Dad; never merged into or offered as an update to the user's own holdings. Only the masked PAN is stored; consent is audited in `eh_ownership_confirmations`. Server rejects commit without it (422 `ownership_unconfirmed`). | someone else's PAN… |
| Ownership | No PAN in the file, or bonds typed manually | v1: no step. v2: one tap "Mine" / "A family member's" before Confirm | removing the other person's file… |
| Ownership | Statement shows the user's own PAN | No extra step (v1 and v2) | own PAN… |
| Portfolio | Older statement | Statement date read from the file; warning if older than saved or > 30 days | an older statement… |
| Payouts | No upcoming payouts | "No upcoming payouts" empty state | no payouts → empty list |
| Payouts | Missed or past payout | "Past payouts to confirm" section, never shown as Upcoming | past payouts are past… |
| Payouts | Bond matures | "Matured" tag, out of active principal, no further payouts | past payouts are past… |
| Payouts | Payout date changes | Bond terms re-fetched every 6 hours; vendor schedule wins | sync test |
| Payouts | Incomplete coupon information | "Estimated" label; Details-awaited bonds listed separately and left out of totals | user-entered bonds are marked estimated |
| User action | User exits during upload | Draft saved; "Continue where you left off?" on the External tab | leaving mid-upload… |
| User action | User deletes a portfolio | Confirmation sheet; payouts, received marks and pending reminders removed | deleting a portfolio… |
