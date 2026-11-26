import { parseImage, type OcrEngine } from './image';
import { parsePdf } from './pdf';
import { parseCsvBuffer, parseExcel } from './sheet';
import type { ParseResult } from './extract';

export type ImportMethod = 'pdf' | 'excel' | 'csv' | 'screenshot';

export function detectMethod(filename: string, mime: string, head: Uint8Array): ImportMethod | null {
  const n = filename.toLowerCase();
  const sig = Array.from(head.slice(0, 8));
  if (sig[0] === 0x25 && sig[1] === 0x50 && sig[2] === 0x44 && sig[3] === 0x46) return 'pdf'; // %PDF
  if (sig[0] === 0x50 && sig[1] === 0x4b && /\.(xlsx|xlsm)$/.test(n)) return 'excel'; // zip container
  if (sig[0] === 0x89 && sig[1] === 0x50) return 'screenshot'; // PNG
  if (sig[0] === 0xff && sig[1] === 0xd8) return 'screenshot'; // JPEG
  if (/^image\/(png|jpe?g|webp|heic)$/.test(mime)) return 'screenshot';
  if (/\.(csv|txt)$/.test(n) || mime === 'text/csv') return 'csv';
  if (/\.xls$/.test(n)) return null; // legacy binary Excel: ask the user to save as .xlsx or .csv
  return null;
}

export async function parseFile(
  method: ImportMethod,
  buf: Uint8Array,
  opts: { password?: string; ocr: OcrEngine },
): Promise<ParseResult> {
  switch (method) {
    case 'pdf':
      return parsePdf(buf, opts.password);
    case 'excel':
      return parseExcel(buf);
    case 'csv':
      return parseCsvBuffer(buf);
    case 'screenshot':
      return parseImage(buf, opts.ocr);
  }
}

export { PdfPasswordError } from './pdf';
export type { ParsedRow, ParseResult } from './extract';
