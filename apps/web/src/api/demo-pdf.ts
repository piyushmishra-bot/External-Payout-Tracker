/**
 * Demo only: read a real PDF in the browser with the SAME parser the server uses
 * (apps/api/src/parsers/pdf.ts), so the demo can be tested with real CAS statements.
 * pdf.js runs on the main thread ("fake worker") so the single-file demo needs no worker file.
 */
import type { ParseResult } from '../../../api/src/parsers/extract';

export async function readPdfInBrowser(file: File, password?: string): Promise<ParseResult> {
  const g = globalThis as { pdfjsWorker?: unknown };
  if (!g.pdfjsWorker) g.pdfjsWorker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
  const { parsePdf } = await import('../../../api/src/parsers/pdf');
  return parsePdf(new Uint8Array(await file.arrayBuffer()), password);
}

export function isPasswordError(e: unknown): 'required' | 'incorrect' | null {
  const err = e as { name?: string; reason?: string; code?: number };
  if (err?.name === 'PdfPasswordError' || err?.reason) return (err.reason as 'required' | 'incorrect') ?? 'required';
  if (err?.name === 'PasswordException') return err.code === 2 ? 'incorrect' : 'required';
  return null;
}
