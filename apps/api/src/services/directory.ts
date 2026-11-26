import { isValidIsin, type BondTerms, type Frequency } from '@eh/core';
import { isoDate, type Db } from '../db';
import { parseCsv } from '../parsers/grid';
import type { BondDataProvider } from '../providers/types';
import type { BondService } from './bonds';

/**
 * Bond directory file (CSV or .xlsx), one bond per row. Header names are matched loosely
 * (case, spaces and punctuation ignored). Required: ISIN, Name, Coupon, Frequency, Maturity, FaceValue.
 * Optional: Issuer (defaults to the name), Type (NCD/Bond/…), Rating, Rating agency, Issue date,
 * PayoutPerUnit (amount paid per unit at maturity, needed for zero-coupon bonds), Source (kept as a note).
 * Dates: 19/11/2028, 19-Nov-2028, 2028-11-19 or an Excel date cell.
 */
export type DirectoryRow = BondTerms & { note?: string; externalId?: string };
export type DirectoryProblem = { row: number; isin?: string; message: string };

const FREQ: Record<string, Frequency> = {
  monthly: 12, month: 12, '12': 12,
  quarterly: 4, quarter: 4, '4': 4,
  semiannual: 2, halfyearly: 2, semiannually: 2, '2': 2,
  annual: 1, annually: 1, yearly: 1, '1': 1,
  zerocoupon: 0, zero: 0, atmaturity: 0, onmaturity: 0, cumulative: 0, '0': 0,
};
const MON: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const key = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const pad = (n: number) => String(n).padStart(2, '0');

function validDate(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
}

export function parseDirectoryDate(v: unknown): string | null {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : validDate(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
  const s = String(v ?? '').trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return validDate(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s); // Indian order: day/month/year
  if (m) return validDate(+m[3], +m[2], +m[1]);
  m = /^(\d{1,2})[\s-]([A-Za-z]{3})[A-Za-z]*[\s-,]+(\d{4})$/.exec(s);
  if (m && MON[m[2].toLowerCase()]) return validDate(+m[3], MON[m[2].toLowerCase()], +m[1]);
  return null;
}

const num = (v: unknown) => {
  if (v == null || v === '') return NaN;
  return typeof v === 'number' ? v : Number(String(v).replace(/[₹,%\s]/g, ''));
};

function securityType(t: string): BondTerms['securityType'] {
  const k = key(t);
  if (!k) return undefined;
  if (k.includes('ncd') || k.includes('debenture')) return 'ncd';
  if (k.includes('gsec') || k.includes('government')) return 'gsec';
  if (k.includes('sdl')) return 'sdl';
  if (k.includes('tbill')) return 'tbill';
  if (k.includes('bond')) return 'bond';
  return 'other';
}

/** Reads a directory grid (header row + one row per bond). Rows with problems are reported, never half-saved. */
export function directoryFromGrid(grid: unknown[][]): { bonds: DirectoryRow[]; problems: DirectoryProblem[] } {
  const hi = grid.findIndex((r) => r.some((c) => key(c) === 'isin'));
  if (hi < 0) return { bonds: [], problems: [{ row: 1, message: 'No header row with an "ISIN" column found.' }] };
  const head = grid[hi].map(key);
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const c = {
    isin: col('isin'),
    name: col('name', 'bondname', 'securityname'),
    issuer: col('issuer', 'issuername'),
    type: col('type', 'securitytype', 'instrumenttype'),
    coupon: col('coupon', 'couponrate', 'coupon%', 'rate'),
    freq: col('frequency', 'interestfrequency', 'couponfrequency', 'interestpayment'),
    maturity: col('maturity', 'maturitydate'),
    face: col('facevalue', 'fv', 'parvalue'),
    rating: col('rating', 'creditrating'),
    agency: col('ratingagency', 'agency'),
    payout: col('payoutperunit', 'maturityamount', 'redemptionamount'),
    source: col('source', 'remarks', 'note'),
    issue: col('issuedate', 'allotmentdate', 'dateofallotment'),
  };
  const missing = (['isin', 'name', 'coupon', 'freq', 'maturity', 'face'] as const).filter((k) => c[k] < 0);
  if (missing.length)
    return { bonds: [], problems: [{ row: hi + 1, message: `Missing column(s): ${missing.map((k) => ({ isin: 'ISIN', name: 'Name', coupon: 'Coupon', freq: 'Frequency', maturity: 'Maturity', face: 'FaceValue' })[k]).join(', ')}` }] };

  const bonds: DirectoryRow[] = [];
  const problems: DirectoryProblem[] = [];
  const seen = new Set<string>();
  grid.slice(hi + 1).forEach((r, i) => {
    const rowNo = hi + 2 + i;
    const get = (k: number) => (k >= 0 ? r[k] : undefined);
    const str = (k: number) => String(get(k) ?? '').trim();
    if (r.every((x) => String(x ?? '').trim() === '')) return; // blank line
    const isin = str(c.isin).toUpperCase().replace(/\s/g, '');
    const bad = (message: string) => problems.push({ row: rowNo, isin: isin || undefined, message });
    if (!isValidIsin(isin)) return bad(`ISIN "${isin}" is not valid (check the 12 characters and the last check digit).`);
    if (seen.has(isin)) return bad('Same ISIN appears more than once in the file; only the first row was used.');
    const name = str(c.name);
    if (!name) return bad('Name is empty.');
    const coupon = num(get(c.coupon));
    if (!(coupon >= 0 && coupon <= 50)) return bad(`Coupon "${str(c.coupon)}" must be a number between 0 and 50.`);
    const fq = FREQ[key(get(c.freq))];
    if (fq === undefined) return bad(`Frequency "${str(c.freq)}" not recognised. Use Monthly, Quarterly, Semi-annual, Annual or Zero coupon.`);
    const maturity = parseDirectoryDate(get(c.maturity));
    if (!maturity) return bad(`Maturity "${str(c.maturity)}" is not a date (use dd/mm/yyyy).`);
    const face = num(get(c.face));
    if (!(face > 0)) return bad(`FaceValue "${str(c.face)}" must be more than 0.`);
    const issueRaw = get(c.issue);
    const issueDate = issueRaw != null && String(issueRaw).trim() !== '' ? parseDirectoryDate(issueRaw) : undefined;
    if (issueDate === null) return bad(`Issue date "${str(c.issue)}" is not a date.`);
    if (issueDate && issueDate >= maturity) return bad(`Issue date ${issueDate} is not before maturity ${maturity}.`);
    const payout = num(get(c.payout));
    const zero = fq === 0 || coupon === 0;
    if (zero && !(payout > 0)) return bad('Zero-coupon bond: add PayoutPerUnit (amount paid per unit at maturity).');
    seen.add(isin);
    bonds.push({
      isin,
      name,
      issuer: str(c.issuer) || name,
      faceValue: face,
      couponRate: coupon,
      frequency: zero ? 0 : fq,
      couponType: zero ? 'zero' : 'fixed',
      dayCount: 'ACT/ACT',
      issueDate: issueDate ?? undefined,
      maturityDate: maturity,
      rating: str(c.rating) || undefined,
      ratingAgency: str(c.agency) || undefined,
      maturityAmount: zero ? payout : undefined,
      securityType: securityType(str(c.type)) ?? 'ncd',
      source: 'directory',
      verified: true,
      note: str(c.source) || undefined,
    });
  });
  return { bonds, problems };
}

export async function parseDirectoryFile(fileName: string, data: Uint8Array) {
  if (/\.xlsx$/i.test(fileName)) {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(data as any);
    let best: ReturnType<typeof directoryFromGrid> | null = null;
    wb.eachSheet((ws) => {
      const grid: unknown[][] = [];
      ws.eachRow({ includeEmpty: false }, (r) =>
        grid.push((r.values as unknown[]).slice(1).map((v: any) => (v && typeof v === 'object' && !(v instanceof Date) ? v.result ?? v.text ?? v.richText?.map((t: any) => t.text).join('') ?? '' : v))),
      );
      const res = directoryFromGrid(grid);
      if (!best || res.bonds.length > best.bonds.length) best = res;
    });
    return best ?? { bonds: [], problems: [{ row: 1, message: 'The workbook has no sheets.' }] };
  }
  if (/\.csv$/i.test(fileName)) return directoryFromGrid(parseCsv(new TextDecoder('utf-8').decode(data).replace(/^﻿/, '')));
  return { bonds: [], problems: [{ row: 0, message: 'Upload a .csv or .xlsx file.' }] };
}

export class DirectoryService {
  constructor(private readonly db: Db, private readonly bondService: BondService) {}

  /** Adds or updates every valid row (upsert by ISIN); also refreshes the lookup cache so changes show at once. */
  async save(bonds: DirectoryRow[], fileName: string) {
    await this.db.tx(async (t) => {
      for (const b of bonds)
        await t.query(
          `INSERT INTO eh_bond_directory (isin, name, issuer, face_value, coupon_rate, frequency, coupon_type, day_count, issue_date,
             maturity_date, rating, rating_agency, maturity_amount, security_type, note, file_name, cashflows, source, external_id, uploaded_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19, now())
           ON CONFLICT (isin) DO UPDATE SET name=EXCLUDED.name, issuer=EXCLUDED.issuer, face_value=EXCLUDED.face_value,
             coupon_rate=EXCLUDED.coupon_rate, frequency=EXCLUDED.frequency, coupon_type=EXCLUDED.coupon_type,
             day_count=EXCLUDED.day_count, issue_date=EXCLUDED.issue_date, maturity_date=EXCLUDED.maturity_date,
             rating=EXCLUDED.rating, rating_agency=EXCLUDED.rating_agency, maturity_amount=EXCLUDED.maturity_amount,
             security_type=EXCLUDED.security_type, note=EXCLUDED.note, file_name=EXCLUDED.file_name,
             cashflows=EXCLUDED.cashflows, source=EXCLUDED.source, external_id=EXCLUDED.external_id, uploaded_at=now()`,
          [b.isin, b.name, b.issuer, b.faceValue, b.couponRate, b.frequency, b.couponType, b.dayCount, b.issueDate ?? null, b.maturityDate,
           b.rating ?? null, b.ratingAgency ?? null, b.maturityAmount ?? null, b.securityType ?? null, b.note ?? null, fileName,
           b.cashflows?.length ? JSON.stringify(b.cashflows) : null, b.source === 'bondscanner' ? 'bondscanner' : 'directory', b.externalId ?? null],
        );
    });
    for (const b of bonds) await this.bondService.upsert(b);
  }

  async list() {
    const rows = await this.db.query<Record<string, any>>(`SELECT * FROM eh_bond_directory ORDER BY lower(issuer), maturity_date`);
    return rows.map(fromRow);
  }
}

function fromRow(r: Record<string, any>): DirectoryRow {
  return {
    isin: r.isin,
    name: r.name,
    issuer: r.issuer,
    faceValue: Number(r.face_value),
    couponRate: Number(r.coupon_rate),
    frequency: Number(r.frequency) as Frequency,
    couponType: r.coupon_type,
    dayCount: r.day_count,
    issueDate: r.issue_date ? isoDate(r.issue_date) : undefined,
    maturityDate: isoDate(r.maturity_date),
    rating: r.rating ?? undefined,
    ratingAgency: r.rating_agency ?? undefined,
    maturityAmount: r.maturity_amount != null ? Number(r.maturity_amount) : undefined,
    securityType: r.security_type ?? undefined,
    cashflows: r.cashflows ?? undefined,
    source: r.source === 'bondscanner' ? 'bondscanner' : 'directory',
    verified: true,
    note: r.note ?? undefined,
    externalId: r.external_id ?? undefined,
  };
}

/** Bond data source backed by the uploaded directory. First in the lookup chain when enabled. */
export class DirectoryBondProvider implements BondDataProvider {
  readonly name = 'directory';
  constructor(private readonly db: Db) {}
  async getMany(isins: string[]) {
    const rows = await this.db.query<Record<string, any>>(`SELECT * FROM eh_bond_directory WHERE isin = ANY($1)`, [isins]);
    return new Map(rows.map((r) => [r.isin as string, fromRow(r) as BondTerms]));
  }
  async search(q: string, limit: number) {
    const s = q.trim().toLowerCase();
    if (s.length < 2) return [];
    const rows = await this.db.query<Record<string, any>>(
      `SELECT * FROM eh_bond_directory WHERE lower(isin) LIKE $1 OR lower(name) LIKE $1 OR lower(issuer) LIKE $1 ORDER BY lower(issuer), maturity_date LIMIT $2`,
      [`%${s}%`, limit],
    );
    return rows.map((r) => fromRow(r) as BondTerms);
  }
}
