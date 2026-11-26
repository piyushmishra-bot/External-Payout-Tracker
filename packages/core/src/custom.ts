import { addMonths, parseISO } from './dates';
import { bondShortName } from './format';
import type { BondTerms, CustomTerms, ISODate } from './types';

/** Build bond terms from what the user typed. Payouts are marked estimated until verified. */
export function customToTerms(isin: string, c: CustomTerms, today?: ISODate): BondTerms {
  const name = c.name?.trim();
  // Coupons step back from maturity; start the schedule one period before today so no past payouts are invented.
  const issueDate = today ? addMonths(today, -12 / c.frequency, parseISO(c.maturityDate).getUTCDate()) : undefined;
  return {
    isin,
    issuer: name || `Bond ${isin}`,
    name: name ? bondShortName(name, c.maturityDate) : `Bond ${isin}`,
    faceValue: c.faceValue,
    couponRate: c.couponRate,
    frequency: c.frequency,
    couponType: 'fixed',
    dayCount: 'EQUAL',
    issueDate,
    maturityDate: c.maturityDate,
    rating: 'Unrated',
    source: 'user',
    verified: false,
  };
}

/** Validation for the "Add details" form. Returns an error message or null. No upper limits (product decision). */
export function validateCustomTerms(c: Partial<CustomTerms>, today: ISODate): string | null {
  if (!c.maturityDate || !/^\d{4}-\d{2}-\d{2}$/.test(c.maturityDate)) return 'Choose the maturity date';
  const [y, m, d] = c.maturityDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return 'That date does not exist';
  if (c.maturityDate <= today) return 'Maturity date must be in the future';
  if (![1, 2, 4, 12].includes(Number(c.frequency))) return 'Choose how often it pays';
  if (!(Number(c.couponRate) > 0)) return 'Enter the coupon rate';
  if (!(Number(c.faceValue) > 0)) return 'Enter the face value per unit';
  return null;
}

const MON: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Find the statement date in statement text, e.g. "Holdings as on 30-Nov-2026",
 * "Statement Date: 30/11/2026", "for the period 01-Nov-2026 to 30-Nov-2026" (takes the end).
 */
export function findStatementDate(text: string): ISODate | null {
  const t = text.replace(/\s+/g, ' ');
  const DATE = String.raw`(\d{1,2})[\s\-\/\.]([A-Za-z]{3,9}|\d{1,2})[\s\-\/\.,]+(\d{4})`;
  const patterns = [
    new RegExp(String.raw`(?:as\s+on|as\s+of|as\s+at|statement\s+date|holding[s]?\s+as\s+on|valuation\s+date|report\s+date)\s*[:\-]?\s*` + DATE, 'i'),
    new RegExp(String.raw`period\s+.*?to\s+` + DATE, 'i'),
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (!m) continue;
    const day = Number(m[1]);
    const mon = /\d/.test(m[2]) ? Number(m[2]) : MON[m[2].slice(0, 4).toLowerCase()] ?? MON[m[2].slice(0, 3).toLowerCase()];
    const year = Number(m[3]);
    if (!mon || day < 1 || day > 31 || year < 2000) continue;
    return `${year}-${pad(mon)}-${pad(day)}`;
  }
  return null;
}
