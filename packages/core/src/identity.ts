/**
 * Whose holdings is this statement? CAS and most broker statements print the
 * holder's PAN (sometimes masked, e.g. XXXXX1234X) and name. We compare the PAN
 * with the user's KYC PAN. Only a masked PAN is ever stored for someone else.
 */

export interface StatementIdentity {
  /** As printed; may contain X/* masking. Upper-case, no spaces. */
  pan?: string;
  holder?: string;
}

export type Ownership = 'self' | 'other' | 'unknown';

const PAN_TOKEN = /\b([A-Z*X]{5}[0-9*X]{4}[A-Z*X])\b/g;
const PAN_LABEL = /\bPAN(?:\s*(?:No\.?|Number))?\s*[:\-]?\s*([A-Z*X]{5}[0-9*X]{4}[A-Z*X])\b/i;
const NAME_LABEL = /\b(?:Name of (?:the )?(?:first )?holder|First holder|Holder(?:'s)? name|Account holder|Investor name|Client name|Name)\s*[:\-]\s*([A-Z][A-Za-z .']{2,60}?)(?=\s{2,}|\s+PAN\b|\s+Client\b|\s+DP\b|$)/i;

/** A real PAN: 5 letters, 4 digits, 1 letter; 4th letter is the holder type (P = individual). */
export const isFullPan = (s: string) => /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(s);

export function findIdentity(text: string): StatementIdentity {
  const t = text.replace(/\s+/g, ' ');
  const out: StatementIdentity = {};
  const labelled = t.match(PAN_LABEL);
  if (labelled) out.pan = labelled[1].toUpperCase().replace(/\*/g, 'X');
  else {
    // Unlabelled: accept only a full, valid-looking PAN to avoid matching random codes.
    for (const m of t.toUpperCase().matchAll(PAN_TOKEN)) if (isFullPan(m[1])) {
      out.pan = m[1];
      break;
    }
  }
  const name = t.match(NAME_LABEL);
  if (name) out.holder = name[1].trim().replace(/\s+/g, ' ');
  return out;
}

/** XXXXX1234X — what we show and store for a PAN that is not the user's. */
export function maskPan(pan: string): string {
  const p = pan.toUpperCase();
  return p.length === 10 ? `XXXXX${p.slice(5, 9)}${p[9]}` : p;
}

/**
 * Does a (possibly masked) statement PAN belong to the user?
 *  - Full PAN printed (no masking): exact match.
 *  - Masked PAN (X or * in place of characters, e.g. XXXXX1234X): compare only the
 *    visible characters; at least 4 must be visible, otherwise we cannot tell.
 */
export function panOwnership(statementPan: string | undefined, userPan: string | undefined): Ownership {
  if (!statementPan || !userPan) return 'unknown';
  const a = statementPan.toUpperCase().replace(/\*/g, 'X');
  const b = userPan.toUpperCase();
  if (a.length !== 10 || !isFullPan(b)) return 'unknown';
  const masked = !isFullPan(a) || (a.match(/X/g) ?? []).length >= 3;
  if (!masked) return a === b ? 'self' : 'other';
  let visible = 0;
  for (let i = 0; i < 10; i++) {
    if (a[i] === 'X') continue;
    if (a[i] !== b[i]) return 'other';
    visible++;
  }
  return visible >= 4 ? 'self' : 'unknown';
}

/** Combine per-file results: any other-PAN file makes the import 'other'. */
export function combineOwnership(list: Ownership[]): Ownership {
  if (list.includes('other')) return 'other';
  if (list.length && list.every((o) => o === 'self')) return 'self';
  return 'unknown';
}
