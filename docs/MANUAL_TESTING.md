# Manual edge-case testing (real API, no demo)

```bash
npm run seed -w apps/api
npm run dev:api                                   # API on :4010
VITE_DEV_USER_ID=demo-1 npm run dev -w apps/web   # http://localhost:5173/external-payout (real API, not the demo build)
npm run make:test-files -w apps/api               # sample statements in ./test-files
```

On Windows PowerShell, set the user first: `$env:VITE_DEV_USER_ID="demo-1"; npm run dev -w apps/web`.
To start from a clean user, use another id (e.g. `demo-2`); ids starting with `demo` get KYC PAN `ABCDE1234F`.

Open http://localhost:5173/external-payout → **Add holdings** (or **Upload holdings**), then upload files from `test-files/`.

## Add holdings

Add holdings opens two options: **Add manually** (ISIN, Issuer name, Date of investment, Yield, Units, Investment amount; add several, then Review and Save) and **Upload template**. Below them, **Have it in another format?** takes any file up to 4 MB (statement PDF, screenshot, Excel) with an optional note; it appears in the admin page under "Files sent by visitors" (download, Mark as added) and the visitor sees "We're adding your holdings…" on the holdings page, then "Your holdings are updated…" once marked.

The holdings page shows all holdings in one table: + Add holdings and Edit (Edit shows the pencil and × on each row, then Done). Pop-ups follow bondscanner.com: artwork, close ×, centred text, Cancel and the action side by side.

## Holdings template

Add holdings = download the template, fill one row per bond, upload it (.xlsx, .csv, or a text/HTML .xls; a binary .xls is asked to be saved as .xlsx or CSV). The file is read in the browser and matched against the bond directory by ISIN; only the checked rows are saved.

| Column | Notes |
|---|---|
| ISIN | 12 characters, check digit must be right |
| Issuer name | Company that issued the bond (shown under the ISIN) |
| Units | Whole number |
| Investment amount (₹) | Total paid for these units; summed as Total investment |
| Date of investment | dd/mm/yyyy, not in the future |
| Yield (% p.a.) | 0–50, e.g. 11.65 (a % sign is fine) |

All six are required; any other columns are ignored. Header spellings like "Quantity", "Invested amount", "Purchase date" are accepted.

- **Bond in the directory** (bondscanner.com sync or uploaded file): name, coupon, frequency, maturity and payouts come from there.
- **Bond not in the directory**: saved with the amount, units, date and yield and shown as **Details not available** (no coupon, maturity or payouts); its amount counts in Total investment and its yield in Expected yield.
- Rows with problems are listed (row number + reason) and skipped; the valid rows can still be saved.
- The ISIN's last character must match the ISO 6166 check digit, so a mistyped ISIN is flagged.
- The same ISIN on different dates of investment stays as separate rows (separate purchases) and is saved that way; Bonds counts it once. Rows with the same ISIN **and** the same date are combined (units and amounts added, yield averaged by amount) and listed above the preview.
- Every upload goes into one holding ("My holdings", created on the first upload); there is no "Save to" choice. Rows are added straight away, including a bond you already hold bought on another date. Only when a row has the same ISIN **and** the same date of investment as a saved row does a pop-up list them (saved vs in this file) with **Replace with this file** (those saved rows are replaced) or **Add as new rows** (kept, and the file's rows added). Bonds not in the file are never removed by an upload; use Remove bond.
- The template downloads empty (header row only); an example is on the Excel template's Instructions sheet.
- The Terms checkbox is shown on every upload and Save stays disabled until it is ticked.

Test files: `15_Holdings_template_filled.csv` / `16_…xlsx` (3 bonds in the directory after the sync and test-directory upload, plus `INE0UNK07017` shown as Fetching details; ₹4,09,600 invested), `17_Holdings_template_with_errors.csv` (bad ISIN, 2.5 units, zero amount, no date, future date, same ISIN twice, combined when the dates match).

Results page (consolidated view): Overview (Total investment, Bonds, Average yield) and a holdings table per holding (ISIN, Date of investment, Yield in green, Units, Investment amount; a list on phones). The holding bar shows + Add holdings and Edit; Edit switches to the name (edit in place), Delete holding and Save, and shows edit (pencil) and remove (×) on each row, like the BondScanner watchlist. Dates are dd/mm/yyyy; amounts show paise only when there are any; yields up to 2 decimals without trailing zeros. The eye button hides every figure (amounts, yield, units, dates). Payouts, coupon, maturity, active principal and expected returns are hidden for now (`SHOW_PAYOUTS` in `External.tsx`).

## Older upload paths (statement files; API only now)

The dev API keeps its data in `apps/api/.pglite-data`, so it survives restarts. Stop the API before `npm run seed` (only one process can open that folder). Delete the folder to start from scratch.

| File | Edge case | Expected |
|---|---|---|
| `01_Zerodha.csv` | Normal statement with a share mixed in | 2 bonds read; Some Equity Ltd skipped as not a bond; statement date 15 Nov 2026 |
| `01` + `02_Grip.pdf` together | Multiple files, same bond in both | Aster units added (3 + 2 = 5), listed from both files |
| `03_broken.pdf` | Corrupted file | "We could not read this file…" — other files in the same upload still go through |
| `04_empty.csv` | Empty statement | "No holdings found in this file." |
| `05_notes.docx` | Unsupported type | "Upload a PDF, Excel (.xlsx), CSV or a screenshot…" |
| `06_Shares_only.pdf` | Only shares | "Only shares or mutual funds found…" |
| `07_CAS_locked_pw_ABCDE1234F.pdf` | Password-protected PDF (needs `qpdf` to generate) | Asks for password; wrong one → "That password did not work…"; `ABCDE1234F` reads it |
| `08_problems.csv` | Invalid ISIN, missing units, 0 and negative units, unknown ISIN | Bad ISIN "Check ISIN"; missing / 0 / negative → "Units missing" and Confirm blocked; Lateral Bonds → "Details awaited" |
| `09_Wint_Holdings.xlsx` | Excel, zero-coupon bond | 3 bonds read; Halcyon has a single payout at maturity |
| `01_Zerodha.csv` again after saving it | Same file twice | "You already added this exact file before, so it was skipped." — but after deleting that holding, or removing any bond from it, the file is read again |
| `10_Zerodha_newer.csv` after saving `01` | Newer statement | Brightline shown as Changed (10 → 6); Aster missing → "Still hold it" / "Sold it"; Meridian new |
| `11_Zerodha_older_Sep.csv` after saving `01` | Older statement | Warning that the statement is older than the saved one / over 30 days old |
| `12_partial_overlap.csv` after saving `01` | Partial overlap | "Add only the 1 new bond", "Update", or "Add as a separate holding" |
| `13_Own_PAN.pdf` | Statement with the user's own PAN | No extra step |
| `14_Family_member_PAN.pdf` | Someone else's PAN | v1: saved with no check. With `EH_OWNERSHIP_CHECK=true` on the API: family-member confirmation required |

Not file-based — try in the app: ⋮ on a bond → **Edit details** / **Remove bond** (removing the last bond removes the holding); a bond not in our data → Add details → shown with your amount, date and yield and counted in totals; Add manually (future date rejected), exit mid-upload and come back ("Continue where you left off?"), delete a portfolio, mark a payout received, open the payout calendar and the report.
Screenshots: take one of `02_Grip.pdf` and upload the PNG (Tesseract OCR reads it on the API).

## Bond directory (test data before SNAPE/Deridata access)

Bonds in an uploaded directory are recognised by ISIN in statements and Add manually, with their coupon, frequency and maturity used for payouts. The directory is checked before SNAPE/Deridata.

**File:** CSV or Excel (.xlsx), one bond per row. Column names are matched loosely (case and spaces ignored).

| Column | Required | Notes |
|---|---|---|
| ISIN | yes | 12 characters, check digit must be right |
| Name | yes | Shown in the app |
| Issuer | no | Defaults to Name |
| Coupon | yes | % a year, 0–50 |
| Frequency | yes | Monthly, Quarterly, Semi-annual, Annual, or Zero coupon |
| Maturity | yes | 19/11/2028, 19-Nov-2028, 2028-11-19 or an Excel date |
| FaceValue | yes | Per unit, in ₹ |
| Issue date | no | Used for the first coupon period |
| Rating, Rating agency | no | Blank shows as Unrated |
| PayoutPerUnit | zero-coupon only | Amount paid per unit at maturity |
| Type, Source | no | Type: NCD/Bond/…; Source is kept as a note |

**Upload (API must be running with `EH_ADMIN_TOKEN` set; locally it is set in `.claude/launch.json`):**

```powershell
$env:EH_ADMIN_TOKEN = "<same key the API uses>"
npm run import:directory -w apps/api -- "C:\path\to\directory.csv" --dry-run   # check only
npm run import:directory -w apps/api -- "C:\path\to\directory.csv"             # check and save
```

Each run prints how many rows were saved and lists any row that was skipped, with the reason. Uploading again updates bonds by ISIN (nothing is deleted). For a server other than local, also set `API_URL`, e.g. `$env:API_URL = "https://<api-host>"`.

Without the script: `POST /v1/external-holdings/admin/bond-directory` with header `x-admin-token` and the file as form field `file` (add `?dryRun=1` to check only). `GET` on the same path lists what is loaded.

### Filling the directory from bondscanner.com

`npm run sync:bondscanner -w apps/api` (add `-- --dry-run` to read without saving) reads every live bond on bondscanner.com and saves it to the directory with its coupon, frequency, face value, issue/maturity dates, rating and the issuer's own payout schedule (per unit). Payouts for these bonds use that schedule and are not marked estimated. Needs the API running and `EH_ADMIN_TOKEN` set, like `import:directory`. About 140 requests, roughly 30 seconds; run it daily to pick up new and changed bonds.

How it reads the site (bondscanner.com's internal endpoints, not a published API; ask the BondScanner team for a stable endpoint before production):
- list: `GET https://loom.bondscanner.com/v1/issuer/isins?page=N` (live bonds, 10 per page)
- details: `GET https://bondscanner.com/_next/data/<buildId>/deal-details/<ISIN>/<ID>.json` (`buildId` is read from the site and refreshed if the site is redeployed mid-run)

Only bonds currently listed on BondScanner are covered; bonds bought elsewhere still need the uploaded directory or SNAPE/Deridata. Synced rows replace uploaded rows with the same ISIN.
