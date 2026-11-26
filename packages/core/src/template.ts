import { isValidIsin } from './isin';
import type { ISODate } from './types';

/**
 * The holdings upload template: what the user owns and the yield they bought at. Bond terms (coupon, frequency,
 * maturity, payout schedule) come from our bond directory by ISIN; bonds we do not have yet are saved
 * and shown as "fetching details" until the directory has them.
 * Header names are matched loosely (case, spaces, symbols ignored); any other columns are ignored.
 */
export const TEMPLATE_COLUMNS = [
  { key: 'isin', header: 'ISIN', example: 'INE583D08081', note: '12 characters, e.g. INE583D08081' },
  { key: 'issuer', header: 'Issuer name', example: 'UGRO Capital Limited', note: 'Company that issued the bond' },
  { key: 'units', header: 'Units', example: '2', note: 'Whole number of units (bonds/debentures) you hold' },
  { key: 'invested', header: 'Investment amount (₹)', example: '199500', note: 'Total amount you paid for these units' },
  { key: 'investedOn', header: 'Date of investment', example: '10/11/2026', note: 'dd/mm/yyyy' },
  { key: 'yield', header: 'Yield (% p.a.)', example: '11.65', note: 'Yield at which you bought, e.g. 11.65' },
] as const;

/**
 * Longest issuer name a user can enter. The longest bond name on bondscanner.com is 52 characters
 * ("Hyderabad Metropolitan Development Authority Mar ’44"), so 60 fits every name with room to spare.
 */
export const ISSUER_NAME_MAX = 60;

export type TemplateKey = (typeof TEMPLATE_COLUMNS)[number]['key'];

export interface TemplateRow {
  /** Row number in the file (1 = header), for messages. */
  row: number;
  isin: string;
  /** Issuer name as the user wrote it. */
  issuerName: string;
  units: number;
  investedAmount: number;
  acquiredOn: ISODate;
  /** Yield at purchase, % a year. */
  purchaseYield: number;
}
/** Several rows for the same ISIN and the same date of investment, combined into one row. */
export interface TemplateMerge {
  isin: string;
  acquiredOn: ISODate;
  /** Row numbers in the file that were combined (first one kept). */
  rows: number[];
}
export interface TemplateProblem {
  row: number;
  isin?: string;
  /** The column the problem is in, so a form can show the message under that field. */
  field?: TemplateKey;
  message: string;
}

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const ALIASES: Record<TemplateKey, string[]> = {
  isin: ['isin', 'isincode'],
  issuer: ['issuername', 'issuer', 'nameofissuer', 'company', 'companyname', 'bondname'],
  units: ['units', 'quantity', 'qty', 'noofunits', 'unitsheld'],
  invested: ['investmentamount', 'investmentamountrs', 'investedamount', 'investedamountrs', 'amountinvested', 'investment', 'totalinvested', 'amount'],
  investedOn: ['dateofinvestment', 'investmentdate', 'purchasedate', 'dateofpurchase', 'boughton', 'date'],
  yield: ['yieldpa', 'yield', 'ytm', 'yieldatpurchase', 'purchaseyield', 'xirr'],
};
const MON: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number) => String(n).padStart(2, '0');

function realDate(y: number, m: number, d: number): ISODate | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
}

/** 10/11/2026 (day first), 10-Nov-2026, 2026-11-10, or an Excel date cell. */
export function parseTemplateDate(v: unknown): ISODate | null {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : realDate(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
  const s = String(v ?? '').trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return realDate(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) return realDate(+m[3], +m[2], +m[1]);
  m = /^(\d{1,2})[\s-]([A-Za-z]{3})[A-Za-z]*[\s,-]+(\d{4})$/.exec(s);
  if (m && MON[m[2].toLowerCase()]) return realDate(+m[3], MON[m[2].toLowerCase()], +m[1]);
  return null;
}

const num = (v: unknown) => (v == null || String(v).trim() === '' ? NaN : typeof v === 'number' ? v : Number(String(v).replace(/[₹,%\s]/g, '')));

/**
 * Reads a filled template (header row, then one bond per row). Rows with problems are listed, not saved.
 * The same ISIN bought on different dates stays as separate rows (separate purchases). Rows with the same ISIN
 * and the same date of investment are combined: units and amounts added, yield averaged by amount invested.
 */
export function templateFromGrid(grid: unknown[][], today: ISODate): { rows: TemplateRow[]; problems: TemplateProblem[]; merged: TemplateMerge[] } {
  const hi = grid.findIndex((r) => r.some((c) => ALIASES.isin.includes(norm(c))));
  if (hi < 0) return { rows: [], merged: [], problems: [{ row: 1, message: 'This file is not in our holdings template. Please download the template, fill it in and upload it again.' }] };
  const head = grid[hi].map(norm);
  const col = {} as Record<TemplateKey, number>;
  for (const c of TEMPLATE_COLUMNS) col[c.key] = ALIASES[c.key].map((a) => head.indexOf(a)).find((i) => i >= 0) ?? -1;
  const missing = TEMPLATE_COLUMNS.filter((c) => col[c.key] < 0).map((c) => c.header);
  if (missing.length) return { rows: [], merged: [], problems: [{ row: hi + 1, message: `Missing columns: ${missing.join(', ')}. Please use the downloaded template.` }] };

  const rows: TemplateRow[] = [];
  const problems: TemplateProblem[] = [];
  const byLot = new Map<string, TemplateRow>();
  const merges = new Map<string, TemplateMerge>();
  grid.slice(hi + 1).forEach((r, i) => {
    const rowNo = hi + 2 + i;
    const get = (k: TemplateKey) => r[col[k]];
    const str = (k: TemplateKey) => String(get(k) ?? '').trim();
    if (TEMPLATE_COLUMNS.every((c) => str(c.key) === '')) return; // blank line
    const isin = str('isin').toUpperCase().replace(/\s/g, '');
    const bad = (field: TemplateKey, message: string) => problems.push({ row: rowNo, isin: isin || undefined, field, message });
    if (!isValidIsin(isin))
      return bad(
        'isin',
        'Please enter a valid ISIN',
      );
    const issuerName = str('issuer').replace(/\s+/g, ' ');
    if (issuerName.length < 2) return bad('issuer', 'Please enter the issuer name');
    if (issuerName.length > ISSUER_NAME_MAX) return bad('issuer', `Issuer name must be ${ISSUER_NAME_MAX} characters or less`);
    const units = num(get('units'));
    if (!(Number.isInteger(units) && units > 0)) return bad('units', 'Units must be a whole number greater than 0');
    const invested = num(get('invested'));
    if (!(invested > 0)) return bad('invested', 'Investment amount must be greater than ₹0');
    if (!str('investedOn')) return bad('investedOn', 'Please enter the date of investment');
    const acquiredOn = parseTemplateDate(get('investedOn'));
    if (!acquiredOn) return bad('investedOn', 'Please enter a valid date (dd/mm/yyyy)');
    if (acquiredOn > today) return bad('investedOn', 'Date of investment cannot be a future date');
    const purchaseYield = num(get('yield'));
    if (!(purchaseYield > 0 && purchaseYield <= 50)) return bad('yield', 'Yield must be between 0% and 50%');
    const amount = Math.round(invested * 100) / 100;
    const lot = `${isin}|${acquiredOn}`;
    const prev = byLot.get(lot);
    if (!prev) {
      const row = { row: rowNo, isin, issuerName, units, investedAmount: amount, acquiredOn, purchaseYield };
      byLot.set(lot, row);
      rows.push(row);
      return;
    }
    // Same bond, same date: one purchase with the totals.
    const total = prev.investedAmount + amount;
    prev.purchaseYield = Math.round(((prev.purchaseYield * prev.investedAmount + purchaseYield * amount) / total) * 100) / 100;
    prev.units += units;
    prev.investedAmount = Math.round(total * 100) / 100;
    const m = merges.get(lot) ?? { isin, acquiredOn, rows: [prev.row] };
    m.rows.push(rowNo);
    merges.set(lot, m);
  });
  if (!rows.length && !problems.length) problems.push({ row: hi + 2, message: 'The file has no bonds. Please add one bond per row below the header.' });
  return { rows, problems, merged: [...merges.values()] };
}

/** The template as CSV text: the header row only; the user adds one row per bond. */
export function templateCsv(): string {
  const q = (s: string) => (/[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return TEMPLATE_COLUMNS.map((c) => q(c.header)).join(',') + '\r\n';
}
