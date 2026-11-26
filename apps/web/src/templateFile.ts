import { TEMPLATE_COLUMNS, templateCsv, templateFromGrid } from '@eh/core';
import { parseCsv } from '../../api/src/parsers/grid';

const FILE_BASE = 'BondScanner_External_Holdings_Template';

function save(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function downloadTemplateCsv() {
  // BOM so Excel opens ₹ and other characters correctly.
  save(new Blob(['﻿' + templateCsv()], { type: 'text/csv;charset=utf-8' }), `${FILE_BASE}.csv`);
}

/** Excel template: an empty Holdings sheet (header row only) and an Instructions sheet with an example. */
export async function downloadTemplateXlsx() {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Holdings', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = TEMPLATE_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: Math.max(16, c.header.length + 4) }));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1C398E' } };
  head.height = 22;
  // Text cells so ISINs and dd/mm/yyyy dates stay exactly as typed.
  TEMPLATE_COLUMNS.forEach((c, i) => {
    if (c.key === 'isin' || c.key === 'investedOn') ws.getColumn(i + 1).numFmt = '@';
  });

  const help = wb.addWorksheet('Instructions');
  help.columns = [{ width: 26 }, { width: 70 }, { width: 24 }, { width: 20 }];
  help.addRow(['How to fill the Holdings sheet']).font = { bold: true, size: 13 };
  help.addRow(['One row per bond, starting on row 2 of the Holdings sheet. Keep the header row as it is. All five columns are required.']);
  help.addRow([]);
  help.addRow(['Column', 'What to enter']).font = { bold: true };
  for (const c of TEMPLATE_COLUMNS) help.addRow([c.header, c.note]);
  help.addRow([]);
  help.addRow(['Example (for reference only; do not copy into the Holdings sheet)']).font = { bold: true };
  help.addRow(TEMPLATE_COLUMNS.map((c) => c.header)).font = { italic: true };
  help.addRow(TEMPLATE_COLUMNS.map((c) => c.example));
  help.addRow([]);
  help.addRow(['Coupon, payout dates and maturity are shown for bonds in our bond data.']);
  help.addRow(['Upload the file on bondscanner.com/bond-portfolio → Add holdings. Uploading again replaces your holdings with the new file.']);

  const buf = await wb.xlsx.writeBuffer();
  save(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${FILE_BASE}.xlsx`);
}

/** Reads a filled template (.xlsx or .csv) in the browser. */
export async function readTemplateFile(file: File, today: string) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.csv')) return templateFromGrid(parseCsv((await file.text()).replace(/^﻿/, '')), today);
  if (name.endsWith('.xlsx')) {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await file.arrayBuffer());
    // The Holdings sheet if present, otherwise the first sheet that has an ISIN column.
    const sheets = wb.worksheets.slice().sort((a, b) => Number(b.name === 'Holdings') - Number(a.name === 'Holdings'));
    for (const ws of sheets) {
      const grid: unknown[][] = [];
      ws.eachRow({ includeEmpty: false }, (r) =>
        grid.push((r.values as unknown[]).slice(1).map((v: any) => (v && typeof v === 'object' && !(v instanceof Date) ? v.result ?? v.text ?? v.richText?.map((t: any) => t.text).join('') ?? '' : v))),
      );
      const res = templateFromGrid(grid, today);
      if (res.rows.length || !res.problems[0]?.message.startsWith('This file is not in our holdings template')) return res;
    }
    return templateFromGrid([], today);
  }
  if (name.endsWith('.xls')) {
    // Many ".xls" exports are really text: tab-separated, CSV or an HTML table. Real (binary) .xls is not read in the browser.
    const buf = new Uint8Array(await file.arrayBuffer());
    if (buf[0] === 0xd0 && buf[1] === 0xcf) return { rows: [], merged: [], problems: [{ row: 0, message: 'This is an older Excel file (.xls). Please save it as .xlsx or .csv (File → Save As in Excel) and upload it again.' }] };
    const text = new TextDecoder('utf-8').decode(buf).replace(/^﻿/, '');
    if (/<table/i.test(text)) {
      const doc = new DOMParser().parseFromString(text, 'text/html');
      const grid = [...doc.querySelectorAll('tr')].map((tr) => [...tr.querySelectorAll('th,td')].map((td) => (td.textContent ?? '').trim()));
      return templateFromGrid(grid, today);
    }
    return templateFromGrid(parseCsv(text), today);
  }
  return { rows: [], merged: [], problems: [{ row: 0, message: 'Please upload the template as an .xlsx or .csv file. For PDFs or other formats, use Send a file below.' }] };
}
