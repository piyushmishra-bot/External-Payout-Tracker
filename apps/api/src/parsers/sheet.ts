import { rowsFromGrid, parseCsvText } from './grid';
import type { ParseResult } from './extract';

export { rowsFromGrid, parseCsv } from './grid';

export async function parseExcel(buf: Uint8Array): Promise<ParseResult> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  let best: ParseResult = { parser: 'excel', rows: [], warnings: [] };
  wb.eachSheet((ws) => {
    const grid: unknown[][] = [];
    ws.eachRow({ includeEmpty: false }, (r) => {
      const vals = (r.values as unknown[]).slice(1).map((v: any) => (v && typeof v === 'object' ? v.result ?? v.text ?? v.richText?.map((t: any) => t.text).join('') ?? '' : v));
      grid.push(vals);
    });
    const res = rowsFromGrid(grid, 'excel');
    if (res.rows.length > best.rows.length) best = res;
  });
  return best;
}

export function parseCsvBuffer(buf: Uint8Array): ParseResult {
  return parseCsvText(new TextDecoder('utf-8').decode(buf));
}
