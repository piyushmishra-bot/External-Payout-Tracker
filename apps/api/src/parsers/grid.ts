import { findIdentity, findStatementDate } from '@eh/core';
import { cleanIsinCell, mergeRows, nearIsinCell, parseNumber, rowsFromLines, type ParsedRow, type ParseResult } from './extract';

/* Pure grid parsing (no Node or Excel deps) so the web demo can reuse it. */
const HEADERS = {
  isin: /\bisin\b/i,
  units: /(qty|quantity|units?\b|no\.?\s*of\s*(bonds|units|debentures|ncds?)|holding|balance|free\s*bal)/i,
  name: /(security|scrip|bond\s*name|instrument|description|^name$|company)/i,
  invested: /(invested|investment\s*amount|cost|purchase\s*(value|amount)|amount\s*paid)/i,
};

/** Parse a grid of cells (from Excel or CSV). Uses headers if found, otherwise falls back to line heuristics. */
export function rowsFromGrid(grid: unknown[][], parser: string): ParseResult {
  const str = (v: unknown) => (v == null ? '' : String(v).trim());
  for (let h = 0; h < Math.min(grid.length, 30); h++) {
    const header = grid[h].map(str);
    const col = (re: RegExp) => header.findIndex((c) => re.test(c));
    const iIsin = col(HEADERS.isin);
    const iUnits = header.findIndex((c, i) => i !== iIsin && HEADERS.units.test(c));
    if (iIsin < 0 || iUnits < 0) continue;
    const iName = header.findIndex((c, i) => i !== iIsin && HEADERS.name.test(c));
    const iInv = col(HEADERS.invested);
    const rows: ParsedRow[] = [];
    const warnings: string[] = [];
    for (const r of grid.slice(h + 1)) {
      const isin = cleanIsinCell(r[iIsin]);
      const near = isin ? null : nearIsinCell(r[iIsin]);
      if (!isin && !near) {
        if (str(r[iIsin])) warnings.push(`Skipped "${str(r[iIsin]).slice(0, 20)}": not a valid ISIN`);
        continue;
      }
      const rawUnits = str(r[iUnits]).replace(/[,\s₹]/g, '');
      const units = typeof r[iUnits] === 'number' ? (r[iUnits] as number) : /^-\d/.test(rawUnits) ? -Number(rawUnits.slice(1)) : parseNumber(str(r[iUnits]));
      const inv = iInv >= 0 ? (typeof r[iInv] === 'number' ? (r[iInv] as number) : parseNumber(str(r[iInv]))) : null;
      rows.push({
        isin: isin ?? near!,
        invalidIsin: !isin || undefined,
        // Zero or negative units are kept (as missing) so the user is asked to fix them.
        units: units && units > 0 ? units : undefined,
        nameHint: iName >= 0 ? str(r[iName]) || undefined : undefined,
        investedAmount: inv && inv > 0 ? inv : undefined,
        confidence: 'high',
      });
    }
    const head = grid.slice(0, h + 1).map((r) => r.map(str).join('   ')).join('   ');
    return { parser: `${parser}-headers`, rows: mergeRows(rows), warnings, statementDate: findStatementDate(head) ?? undefined, identity: findIdentity(head) };
  }
  return rowsFromLines(grid.map((r) => r.map(str).join(' ')), `${parser}-scan`, 'low');
}

/** RFC 4180-ish CSV parser (quotes, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',' || c === ';' || c === '\t') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      out.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    out.push(row);
  }
  return out;
}

export function parseCsvText(text: string): ParseResult {
  return rowsFromGrid(parseCsv(text.replace(/^\uFEFF/, '')), 'csv');
}
