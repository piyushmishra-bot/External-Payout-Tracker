/**
 * ISIN helpers (ISO 6166) with India-specific classification.
 *
 * Indian ISIN layout: IN + issuer type (1) + issuer code (4) + security type (2) + serial (2) + check (1)
 *   INE… companies, INF… mutual funds, IN0…/IN1…/IN2… central/state government securities.
 * NSDL security-type codes (positions 8-9): 01 equity, 07/08 debentures and bonds, 14/16 CP/CD, …
 */

export const ISIN_RE = /\bIN[A-Z0-9]{9}[0-9]\b/g;

export function isinCheckDigit(first11: string): number {
  const expanded = first11
    .toUpperCase()
    .split('')
    .map((c) => (c >= 'A' && c <= 'Z' ? String(c.charCodeAt(0) - 55) : c))
    .join('');
  let sum = 0;
  // Luhn over the expanded digit string, doubling from the rightmost digit.
  for (let i = expanded.length - 1, dbl = true; i >= 0; i--, dbl = !dbl) {
    let n = Number(expanded[i]);
    if (dbl) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidIsin(isin: string): boolean {
  const s = isin.trim().toUpperCase();
  if (!/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(s)) return false;
  return isinCheckDigit(s.slice(0, 11)) === Number(s[11]);
}

export function normaliseIsin(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase();
}

export type IsinClass = 'corporate_debt' | 'government' | 'equity' | 'mutual_fund' | 'money_market' | 'unknown';

export function classifyIndianIsin(isin: string): IsinClass {
  const s = normaliseIsin(isin);
  if (!s.startsWith('IN')) return 'unknown';
  const issuerType = s[2];
  const secType = s.slice(7, 9);
  if (issuerType === 'F') return 'mutual_fund';
  if (/[0-9]/.test(issuerType)) return 'government';
  if (issuerType === 'E' || issuerType === '9') {
    if (secType === '01') return 'equity';
    if (secType === '07' || secType === '08') return 'corporate_debt';
    if (secType === '14' || secType === '16') return 'money_market';
  }
  return 'unknown';
}

/** Could this ISIN be a bond we track? Used to skip shares and mutual funds during import. */
export function isLikelyBond(isin: string): boolean {
  const c = classifyIndianIsin(isin);
  return c === 'corporate_debt' || c === 'government' || c === 'unknown';
}

/** Find ISINs in free text, keeping only ones with a valid check digit. */
export function findIsins(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toUpperCase().matchAll(ISIN_RE)) if (isValidIsin(m[0])) out.push(m[0]);
  return out;
}
