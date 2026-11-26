import { rowsFromLines, type ParseResult } from './extract';

export class PdfPasswordError extends Error {
  constructor(readonly reason: 'required' | 'incorrect') {
    super(reason === 'required' ? 'This PDF is password protected' : 'Incorrect PDF password');
    this.name = 'PdfPasswordError';
  }
}

/**
 * Extract text lines from a PDF, grouping text items by their y position.
 * Works for CDSL / NSDL consolidated account statements (CAS), broker holding
 * statements and platform portfolio exports that have a text layer.
 * Scanned PDFs (no text layer) return no lines; the caller asks for a screenshot instead.
 */
export async function pdfToLines(buf: Uint8Array, password?: string): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: buf, password, isEvalSupported: false, useSystemFonts: false, verbosity: 0 });
  let doc;
  try {
    doc = await task.promise;
  } catch (e: any) {
    if (e?.name === 'PasswordException') throw new PdfPasswordError(e.code === 2 ? 'incorrect' : 'required');
    throw e;
  }
  const lines: string[] = [];
  for (let p = 1; p <= Math.min(doc.numPages, 60); p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const byY = new Map<number, { x: number; s: string }[]>();
    for (const it of content.items as any[]) {
      if (!it.str?.trim()) continue;
      const y = Math.round(it.transform[5] / 2) * 2; // 2pt buckets absorb tiny baseline shifts
      const x = it.transform[4];
      if (!byY.has(y)) byY.set(y, []);
      byY.get(y)!.push({ x, s: it.str });
    }
    [...byY.entries()]
      .sort((a, b) => b[0] - a[0])
      .forEach(([, items]) => lines.push(items.sort((a, b) => a.x - b.x).map((i) => i.s.trim()).join(' ')));
  }
  await doc.destroy();
  return lines;
}

export async function parsePdf(buf: Uint8Array, password?: string): Promise<ParseResult> {
  const lines = await pdfToLines(buf, password);
  const isCas = lines.some((l) => /consolidated account statement|NSDL|CDSL/i.test(l));
  const res = rowsFromLines(lines, isCas ? 'pdf-cas' : 'pdf-generic', 'low');
  if (!lines.length) res.warnings.push('No text found. This looks like a scanned PDF; try a screenshot instead.');
  return res;
}
