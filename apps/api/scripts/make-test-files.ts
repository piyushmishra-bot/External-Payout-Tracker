/**
 * Writes sample statements for manual edge-case testing against the running app.
 * Usage: npm run make:test-files -w apps/api   (writes to <repo>/test-files)
 * Bonds are the fixture bonds the dev API knows (BOND_PROVIDERS=fixture).
 * The locked PDF needs `qpdf` on PATH; without it that file is skipped.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ExcelJS from 'exceljs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { TEMPLATE_COLUMNS } from '@eh/core';

const OUT = resolve(import.meta.dirname, '../../../test-files');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

async function pdf(lines: string[]) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([820, 420]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  lines.forEach((l, i) => page.drawText(l, { x: 20, y: 390 - i * 22, size: 10, font }));
  return doc.save();
}
const put = (name: string, data: string | Uint8Array) => writeFileSync(join(OUT, name), data);

// Upload
put('01_Zerodha.csv', 'Statement as on 15-Nov-2026\nISIN,Security Name,Quantity\nINE0AST07019,Aster Finance NCD,3\nINE0BHF07027,Brightline Housing NCD,10\nINE0QXZ01015,Some Equity Ltd,100\n');
put('02_Grip.pdf', await pdf(['Holdings as on 16-Nov-2026', 'INE0AST07019  ASTER FINANCE LTD 11.25% NCD 2028   2.000', 'INE0KPC08018  KAVERI POWER 7.85 2031   1.000']));
put('03_broken.pdf', '%PDF-1.7 garbage');
put('04_empty.csv', 'ISIN,Quantity\n');
put('05_notes.docx', new Uint8Array([1, 2, 3]));
put('06_Shares_only.pdf', await pdf(['Holdings as on 15-Nov-2026', 'INE0QXZ01015  SOME EQUITY LTD   50.000']));

const plain = join(OUT, '_plain.pdf');
put('_plain.pdf', await pdf(['Holdings as on 14-Nov-2026', 'INE0PNL07049  PINNACLE LEASING 9.80% NCD   4.000']));
let locked = true;
try {
  execFileSync('qpdf', ['--encrypt', 'ABCDE1234F', 'owner', '256', '--', plain, join(OUT, '07_CAS_locked_pw_ABCDE1234F.pdf')]);
} catch {
  locked = false;
}
rmSync(plain);

// Extraction: invalid ISIN (bad check digit), missing units, zero and negative units, unknown ISIN
put('08_problems.csv', 'ISIN,Security Name,Quantity\nINE0AST07018,Aster typo,5\nINE0MIT07031,Meridian Infra,\nINE0ZRL08013,Zenith Roads,0\nINE0CVC07023,Corvus Capital,-2\nINE0LTB07012,Lateral Bonds (unknown),3\n');

// Excel, including a zero-coupon bond
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('Holdings');
ws.addRow(['Statement as on 10-Nov-2026']);
ws.addRow(['ISIN', 'Security Name', 'Quantity']);
ws.addRow(['INE0NMB07013', 'Nimbus Credit', 5]);
ws.addRow(['INE0PNL07049', 'Pinnacle Leasing', 40]);
ws.addRow(['INE0HLC07015', 'Halcyon Capital ZCB', 3]);
put('09_Wint_Holdings.xlsx', new Uint8Array(await wb.xlsx.writeBuffer()));

// Portfolio: a newer statement of 01_Zerodha (Brightline units changed, Aster missing, Meridian new)
put('10_Zerodha_newer.csv', 'Statement as on 18-Nov-2026\nISIN,Security Name,Quantity\nINE0BHF07027,Brightline Housing NCD,6\nINE0MIT07031,Meridian Infra NCD,8\n');
// Older statement than what is saved, and more than 30 days old
put('11_Zerodha_older_Sep.csv', 'Statement as on 30-Sep-2026\nISIN,Quantity\nINE0AST07019,5\nINE0BHF07027,10\nINE0KPC08018,1\n');
// Partial overlap with 01_Zerodha: one same, one new
put('12_partial_overlap.csv', 'Statement as on 17-Nov-2026\nISIN,Quantity\nINE0BHF07027,10\nINE0ORM07058,2\n');

// Ownership
put('13_Own_PAN.pdf', await pdf(['NSDL Consolidated Account Statement', 'Name: TEST USER   PAN: ABCDE1234F', 'INE0CVC07023  CORVUS CAPITAL NCD   2.000']));
put('14_Family_member_PAN.pdf', await pdf(['CDSL Consolidated Account Statement', 'Name: RAMESH KUMAR   PAN: PQRSX5678K', 'INE0AST07019  ASTER FINANCE NCD   5.000', 'INE0BHF07027  BRIGHTLINE HOUSING NCD   10.000', 'INE0KPC08018  KAVERI POWER BOND   1.000']));

// Holdings template (the only upload format now): a clean one in CSV and Excel, and one with mistakes.
const T_HEAD = TEMPLATE_COLUMNS.map((c) => c.header);
// ISIN, Issuer name, Units, Investment amount, Date of investment, Yield. INE0UNK07017 is valid but in no directory → "fetching details".
const T_ROWS = [
  ['INE583D08081', 'UGRO Capital Limited', '3', '299250', '10/11/2026', '12.45'],
  ['INE134E07ED4', 'Power Finance Corporation', '2', '20100', '01/11/2026', '5.4'],
  ['INE0LN107105', 'Lendingkart Finance', '5', '50250', '18/11/2026', '11.2'],
  ['INE0UNK07017', 'Acme Finance Limited', '4', '40000', '05/10/2026', '10.5'],
];
const csvLine = (r: string[]) => r.map((v) => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',');
put('15_Holdings_template_filled.csv', [T_HEAD, ...T_ROWS].map(csvLine).join('\r\n') + '\r\n');
const tw = new ExcelJS.Workbook();
const ts = tw.addWorksheet('Holdings');
ts.addRow(T_HEAD);
for (const r of T_ROWS) ts.addRow(r);
put('16_Holdings_template_filled.xlsx', new Uint8Array(await tw.xlsx.writeBuffer()));
put(
  '17_Holdings_template_with_errors.csv',
  [
    T_HEAD,
    T_ROWS[0],
    ['INE0LN107106', 'Lendingkart Finance', '5', '50000', '18/11/2026', '11'], // bad check digit
    ['INE134E07ED4', 'Power Finance Corporation', '2.5', '20100', '01/11/2026', '5.4'], // units not whole
    ['INE2PV407QL5', 'Some Issuer', '10', '0', '01/11/2026', '11.5'], // no amount
    ['INE0APB07013', 'Some Issuer', '1', '99500', '', '11'], // no date
    ['INE471Z07019', '', '1', '100000', '01/01/2027', '11'], // no issuer name (and future date)
    T_ROWS[0], // duplicate
  ]
    .map(csvLine)
    .join('\r\n') + '\r\n',
);

console.log(`Wrote test files to ${OUT}`);
if (!locked) console.log('Skipped 07_CAS_locked_pw_ABCDE1234F.pdf: install qpdf (winget install QPDF.QPDF) and run again.');
