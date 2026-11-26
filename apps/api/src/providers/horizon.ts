import type { Db } from '../db';
import type { IsinDirectory, IsinInfo } from './types';
import { StructuralIsinDirectory } from './fixture';

/**
 * Horizon ISIN list. Used during import to (a) skip shares and mutual funds and
 * (b) tell the user "we know this ISIN but have no payout terms yet" vs "unknown ISIN".
 *
 * ⚠️  CONFIRM BEFORE USE: table and column names are placeholders.
 * Run docs/sql/02_horizon_discovery.sql in Superset and edit HORIZON_SQL / normalise().
 */
export const HORIZON_SQL = `
  SELECT isin, security_name, issuer_name, instrument_type, is_active
    FROM horizon.isin_master
   WHERE isin = ANY($1)`;

function normalise(t: unknown): IsinInfo['instrumentType'] {
  const s = String(t ?? '').toLowerCase();
  if (/(debenture|bond|ncd|g-?sec|sdl|t-?bill|debt|commercial paper|certificate of deposit)/.test(s)) return 'debt';
  if (/(equity|share)/.test(s)) return 'equity';
  if (/(mutual|fund|etf)/.test(s)) return 'mutual_fund';
  return 'other';
}

export class HorizonIsinDirectory implements IsinDirectory {
  private readonly fallback = new StructuralIsinDirectory();
  constructor(private readonly db: Db) {}
  async lookup(isins: string[]) {
    const m = await this.fallback.lookup(isins);
    if (!isins.length) return m;
    const rows = await this.db.query<Record<string, any>>(HORIZON_SQL, [isins]);
    for (const r of rows)
      m.set(r.isin, { isin: r.isin, name: r.security_name, issuer: r.issuer_name, instrumentType: normalise(r.instrument_type), active: r.is_active });
    return m;
  }
}
