import { rowsFromLines, type ParsedRow, type ParseResult } from './extract';

/** OCR engine abstraction so we can swap Tesseract for a cloud OCR or vision model later. */
export interface OcrEngine {
  readonly name: string;
  lines(image: Uint8Array): Promise<string[]>;
}

export class TesseractOcr implements OcrEngine {
  readonly name = 'tesseract';
  async lines(image: Uint8Array): Promise<string[]> {
    const { createWorker } = await import('tesseract.js');
    const worker = await createWorker('eng');
    try {
      const { data } = await worker.recognize(Buffer.from(image));
      return data.text.split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean);
    } finally {
      await worker.terminate();
    }
  }
}

export class NoOcr implements OcrEngine {
  readonly name = 'none';
  async lines(): Promise<string[]> {
    throw new Error('Screenshot reading is not enabled');
  }
}

/**
 * Screenshots from other apps often show bond names but no ISIN. We keep those
 * lines as name-only rows; the import service then matches names against the
 * bond master and the user confirms each one.
 */
export async function parseImage(image: Uint8Array, ocr: OcrEngine): Promise<ParseResult> {
  const lines = await ocr.lines(image);
  const res = rowsFromLines(lines, `image-${ocr.name}`, 'low');
  if (!res.rows.length) {
    const nameRows: ParsedRow[] = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      // Heuristic: a line with letters that mentions a typical issuer word, followed by a units/amount line.
      if (/[A-Za-z]{3,}/.test(l) && /(finance|capital|bank|housing|power|infra|ltd|limited|ncd|bond|corp)/i.test(l)) {
        const unitsMatch = (lines[i + 1] ?? '').match(/(\d+)\s*(units?|qty|bonds?)/i) ?? l.match(/(\d+)\s*(units?|qty|bonds?)/i);
        nameRows.push({ nameHint: l.slice(0, 80), units: unitsMatch ? Number(unitsMatch[1]) : undefined, confidence: 'low', source: l });
      }
    }
    res.rows = nameRows;
  }
  return res;
}
