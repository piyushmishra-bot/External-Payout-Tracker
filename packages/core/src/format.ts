import { parseISO } from './dates';
import type { Frequency, ISODate } from './types';

const MS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const MONTHS_SHORT = MS;

/** ₹ with Indian grouping. Paise shown only when non-zero, unless `paise` is forced. */
export function inr(n: number, opts: { paise?: boolean } = {}): string {
  const hasPaise = Math.round(Math.abs(n) * 100) % 100 !== 0;
  const digits = opts.paise ?? hasPaise ? 2 : 0;
  const s = Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${n < 0 ? '−' : ''}₹${s}`;
}

/** Compact rupees: ₹4.2L, ₹1.3Cr. */
export function inrCompact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e7) return `₹${trim(a / 1e7)}Cr`;
  if (a >= 1e5) return `₹${trim(a / 1e5)}L`;
  if (a >= 1e3) return `₹${trim(a / 1e3)}k`;
  return `₹${Math.round(a)}`;
}
const trim = (x: number) => (Math.round(x * 10) / 10).toString();

/** DD/MM/YYYY, the BondScanner table format. */
export const formatDateNumeric = (s: ISODate) => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;

/** 17 Nov 2026 */
export function formatDate(s: ISODate): string {
  const d = parseISO(s);
  return `${d.getUTCDate()} ${MS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Bond display name: issuer + maturity month and year, e.g. "Aster Finance Aug ’28". */
export function bondShortName(issuer: string, maturity: ISODate): string {
  const d = parseISO(maturity);
  return `${issuer.replace(/\s+(Limited|Ltd\.?|Pvt\.?)$/i, '')} ${MS[d.getUTCMonth()]} ’${String(d.getUTCFullYear()).slice(2)}`;
}

export const FREQUENCY_LABEL: Record<Frequency, string> = {
  12: 'Monthly',
  4: 'Quarterly',
  2: 'Half-yearly',
  1: 'Yearly',
  0: 'At maturity',
};

/** Percent as on bondscanner.com: up to 2 decimals, no trailing zeros (11%, 11.5%, 7.75%). */
/** 10% stays 10%; anything with decimals shows two places: 8.9 → 8.90%. */
export const pct = (n: number) => (Number.isInteger(Number(n.toFixed(2))) ? `${Number(n.toFixed(2))}%` : `${n.toFixed(2)}%`);

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}
