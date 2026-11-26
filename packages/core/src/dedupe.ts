/**
 * Duplicate and "newer statement" detection, as in the prototype.
 *  - same:   identical ISINs and identical units → nothing to do.
 *  - update: at least 60% of the smaller list's ISINs overlap → offer to replace.
 * Only the user's external portfolios are compared; the BondScanner portfolio is never replaced.
 */

export interface SimpleRow {
  isin: string;
  units: number;
}

export interface MatchCandidate {
  id: string;
  name: string;
  rows: SimpleRow[];
}

export interface MatchResult {
  portfolioId: string;
  portfolioName: string;
  type: 'same' | 'update';
  coverage: number;
  shared: number;
}

export const UPDATE_THRESHOLD = 0.6;

const toMap = (rows: SimpleRow[]) => {
  const m = new Map<string, number>();
  for (const r of rows) if (r.isin && r.units > 0) m.set(r.isin, (m.get(r.isin) ?? 0) + r.units);
  return m;
};

export function findMatch(incoming: SimpleRow[], portfolios: MatchCandidate[]): MatchResult | null {
  const B = toMap(incoming);
  if (!B.size) return null;
  let best: MatchResult | null = null;
  for (const p of portfolios) {
    const A = toMap(p.rows);
    if (!A.size) continue;
    const shared = [...B.keys()].filter((k) => A.has(k));
    if (!shared.length) continue;
    const coverage = shared.length / Math.min(A.size, B.size);
    const same = A.size === B.size && shared.length === A.size && shared.every((k) => A.get(k) === B.get(k));
    const type = same ? 'same' : coverage >= UPDATE_THRESHOLD ? 'update' : null;
    if (!type) continue;
    const cand: MatchResult = { portfolioId: p.id, portfolioName: p.name, type, coverage, shared: shared.length };
    if (!best || (type === 'same' && best.type !== 'same') || (best.type !== 'same' && coverage > best.coverage)) best = cand;
  }
  return best;
}

export interface Diff {
  added: string[];
  removed: string[];
  changed: { isin: string; from: number; to: number }[];
  unchanged: string[];
}

export function diffRows(existing: SimpleRow[], incoming: SimpleRow[]): Diff {
  const A = toMap(existing);
  const B = toMap(incoming);
  return {
    added: [...B.keys()].filter((k) => !A.has(k)),
    removed: [...A.keys()].filter((k) => !B.has(k)),
    changed: [...B.keys()].filter((k) => A.has(k) && A.get(k) !== B.get(k)).map((k) => ({ isin: k, from: A.get(k)!, to: B.get(k)! })),
    unchanged: [...B.keys()].filter((k) => A.get(k) === B.get(k)),
  };
}

/** Bonds held in more than one portfolio; shown as a warning since they are counted in each. */
export function overlaps(portfolios: MatchCandidate[]): { isin: string; portfolioIds: string[] }[] {
  const seen = new Map<string, string[]>();
  for (const p of portfolios) for (const r of p.rows) seen.set(r.isin, [...(seen.get(r.isin) ?? []), p.id]);
  return [...seen.entries()].filter(([, ids]) => new Set(ids).size > 1).map(([isin, ids]) => ({ isin, portfolioIds: [...new Set(ids)] }));
}
