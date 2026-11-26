import { findIdentity, findIsins, findStatementDate, isValidIsin, normaliseIsin, type StatementIdentity } from '@eh/core';

export interface ParsedRow {
  isin?: string;
  /** Name as printed in the statement; used for matching when there is no ISIN. */
  nameHint?: string;
  units?: number;
  investedAmount?: number;
  /** The ISIN-like text could not be validated (bad check digit / length). User must fix it. */
  invalidIsin?: boolean;
  /** high: structured source (sheet with headers). low: heuristics or OCR; user must check. */
  confidence: 'high' | 'low';
  /** The text the row came from, kept only in memory for debugging, never stored. */
  source?: string;
}

export interface ParseResult {
  parser: string;
  rows: ParsedRow[];
  /** Lines that looked like holdings but had no usable ISIN or quantity. */
  warnings: string[];
  /** Date printed on the statement, if found. */
  statementDate?: string;
  /** Holder PAN / name printed on the statement, if found. */
  identity?: StatementIdentity;
}

/** ISIN-shaped tokens that fail validation (OCR slips, typos). Kept as rows to fix, never dropped. */
const NEAR_ISIN = /\bIN[A-Z0-9]{8,11}\b/g;

const NUM = /^[₹]?\(?\d{1,3}(?:,\d{2,3})*(?:\.\d+)?\)?$|^[₹]?\d+(?:\.\d+)?$/;

export function parseNumber(s: string): number | null {
  const t = s.replace(/[₹,\s()]/g, '');
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

const isWhole = (n: number) => Math.abs(n - Math.round(n)) < 1e-9;
const looksLikeYear = (n: number, raw: string) => !raw.includes('.') && n >= 1990 && n <= 2100;

/**
 * Pick the quantity from tokens that follow an ISIN on a statement line.
 * Rules, in order:
 *  1. Ignore percentages (coupon in the bond name) and anything glued to letters.
 *  2. Prefer a token printed with 3 decimals (CDSL/NSDL CAS print quantities as 5.000).
 *  3. Otherwise the first whole number that is not a year.
 */
export function pickQuantity(tokens: string[]): number | null {
  const nums: { raw: string; n: number }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i];
    if (raw.endsWith('%') || tokens[i + 1] === '%') continue;
    if (!NUM.test(raw)) continue;
    const n = parseNumber(raw);
    if (n == null || n <= 0) continue;
    nums.push({ raw, n });
  }
  const threeDp = nums.find((x) => /\.\d{3}$/.test(x.raw) && isWhole(x.n));
  if (threeDp) return threeDp.n;
  const whole = nums.find((x) => isWhole(x.n) && !looksLikeYear(x.n, x.raw) && !/\.\d{2}$/.test(x.raw));
  return whole ? whole.n : null;
}

/** Extract holdings from plain text lines (PDF text layer or OCR output). */
export function rowsFromLines(lines: string[], parser: string, confidence: 'high' | 'low' = 'low'): ParseResult {
  const rows: ParsedRow[] = [];
  const warnings: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isins = findIsins(line);
    if (!isins.length) {
      const near = (line.toUpperCase().match(NEAR_ISIN) ?? []).filter((t) => /\d/.test(t) && !isValidIsin(t));
      for (const raw of near) {
        const after = line.slice(line.toUpperCase().indexOf(raw) + raw.length);
        const qty = pickQuantity(after.split(/\s+/).filter(Boolean));
        rows.push({ isin: raw, invalidIsin: true, units: qty ?? undefined, confidence: 'low', source: line.slice(0, 160) });
      }
      continue;
    }
    for (const isin of isins) {
      const at = line.toUpperCase().indexOf(isin);
      const after = line.slice(at + isin.length);
      let tokens = after.split(/\s+/).filter(Boolean);
      let qty = pickQuantity(tokens);
      // Wrapped rows: quantity may sit on the next line.
      if (qty == null && lines[i + 1] && !findIsins(lines[i + 1]).length) {
        tokens = lines[i + 1].split(/\s+/).filter(Boolean);
        qty = pickQuantity(tokens);
      }
      const nameHint = after
        .split(/\s+/)
        .filter((t) => !NUM.test(t))
        .join(' ')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .slice(0, 80);
      rows.push({ isin, units: qty ?? undefined, nameHint: nameHint || undefined, confidence, source: line.slice(0, 160) });
      if (qty == null) warnings.push(`No quantity found for ${isin}`);
    }
  }
  const head = lines.slice(0, 120).join('   ');
  return { parser, rows: mergeRows(rows), warnings, statementDate: findStatementDate(head) ?? undefined, identity: findIdentity(head) };
}

/** Same ISIN appearing twice (e.g. free + pledged balance) is summed. */
export function mergeRows(rows: ParsedRow[]): ParsedRow[] {
  const out: ParsedRow[] = [];
  const byIsin = new Map<string, ParsedRow>();
  for (const r of rows) {
    if (!r.isin) {
      out.push(r);
      continue;
    }
    const prev = byIsin.get(r.isin);
    if (!prev) {
      const copy = { ...r };
      byIsin.set(r.isin, copy);
      out.push(copy);
    } else if (r.units) {
      prev.units = (prev.units ?? 0) + r.units;
      prev.confidence = 'low';
    }
  }
  return out;
}

/** Raw ISIN-looking text from a cell that failed validation, so it can be shown for fixing. */
export function nearIsinCell(v: unknown): string | null {
  const s = normaliseIsin(String(v ?? ''));
  return /^IN[A-Z0-9]{8,11}$/.test(s) && /\d/.test(s) && !isValidIsin(s) ? s : null;
}

export function cleanIsinCell(v: unknown): string | null {
  const s = normaliseIsin(String(v ?? ''));
  return isValidIsin(s) ? s : null;
}
