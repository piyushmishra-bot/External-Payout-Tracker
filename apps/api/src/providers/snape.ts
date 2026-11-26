import { bondShortName, type BondTerms, type DayCount, type Frequency } from '@eh/core';
import type { Db } from '../db';
import type { BondDataProvider } from './types';

/**
 * SNAPE: BondScanner's copy of the Deridata bond directory.
 *
 * ⚠️  CONFIRM BEFORE USE. Table and column names below are placeholders written
 * before we had SNAPE access. Once access is granted, open Superset, run
 * docs/sql/01_snape_discovery.sql, and edit SNAPE_SQL and mapRow() to match.
 * Nothing else in the codebase needs to change.
 */
export const SNAPE_SQL = {
  byIsins: `
    SELECT b.isin, b.security_name, b.issuer_name, b.face_value, b.coupon_rate,
           b.interest_frequency, b.coupon_type, b.day_count_convention,
           b.allotment_date, b.maturity_date, b.credit_rating, b.rating_agency,
           b.record_date_days, b.redemption_amount, b.instrument_type, b.is_listed, b.sector, -- TODO(BondScanner): confirm sector column name
           (SELECT json_agg(json_build_object(
                     'date', c.payment_date, 'scheduledDate', c.scheduled_date,
                     'interest', c.interest_amount, 'principal', c.principal_amount,
                     'recordDate', c.record_date) ORDER BY c.payment_date)
              FROM snape.bond_cashflows c WHERE c.isin = b.isin) AS cashflows
      FROM snape.bond_master b
     WHERE b.isin = ANY($1)`,
  search: `
    SELECT b.isin, b.security_name, b.issuer_name, b.face_value, b.coupon_rate,
           b.interest_frequency, b.coupon_type, b.day_count_convention,
           b.allotment_date, b.maturity_date, b.credit_rating, b.rating_agency,
           b.record_date_days, b.redemption_amount, b.instrument_type, b.is_listed, b.sector, -- TODO(BondScanner): confirm sector column name
           NULL AS cashflows
      FROM snape.bond_master b
     WHERE b.maturity_date >= CURRENT_DATE
       AND (b.isin ILIKE $1 || '%' OR b.issuer_name ILIKE '%' || $1 || '%' OR b.security_name ILIKE '%' || $1 || '%')
     ORDER BY b.issuer_name, b.maturity_date
     LIMIT $2`,
};

const FREQ_MAP: Record<string, Frequency> = {
  monthly: 12, m: 12, '12': 12,
  quarterly: 4, q: 4, '4': 4,
  'semi-annual': 2, 'half-yearly': 2, semiannual: 2, h: 2, '2': 2,
  annual: 1, yearly: 1, a: 1, '1': 1,
  cumulative: 0, 'on maturity': 0, 'at maturity': 0, zero: 0, '0': 0,
};

export function mapFrequency(v: unknown): Frequency {
  const k = String(v ?? '').trim().toLowerCase();
  const f = FREQ_MAP[k];
  if (f === undefined) throw new Error(`Unknown interest frequency "${v}"`);
  return f;
}

export function mapDayCount(v: unknown): DayCount {
  const s = String(v ?? '').toUpperCase().replace(/\s/g, '');
  if (s.includes('30/360') || s.includes('30E/360')) return '30/360';
  if (s === 'EQUAL' || s.includes('PERIODIC')) return 'EQUAL';
  return 'ACT/ACT';
}

type Row = Record<string, any>;

export function mapRow(r: Row, source: BondTerms['source'] = 'snape'): BondTerms {
  const frequency = mapFrequency(r.interest_frequency);
  const couponType = String(r.coupon_type ?? '').toLowerCase();
  const issuer = String(r.issuer_name ?? r.security_name).trim();
  const maturityDate = String(r.maturity_date).slice(0, 10);
  return {
    isin: String(r.isin).toUpperCase(),
    issuer,
    name: bondShortName(issuer, maturityDate),
    faceValue: Number(r.face_value),
    couponRate: Number(r.coupon_rate ?? 0),
    frequency,
    couponType: frequency === 0 ? (couponType.includes('zero') ? 'zero' : 'cumulative') : couponType.includes('float') ? 'floating' : 'fixed',
    dayCount: mapDayCount(r.day_count_convention),
    issueDate: r.allotment_date ? String(r.allotment_date).slice(0, 10) : undefined,
    maturityDate,
    rating: r.credit_rating ?? undefined,
    ratingAgency: r.rating_agency ?? undefined,
    sector: r.sector ?? undefined,
    recordDateOffsetDays: r.record_date_days != null ? Number(r.record_date_days) : undefined,
    maturityAmount: r.redemption_amount != null ? Number(r.redemption_amount) : undefined,
    cashflows: Array.isArray(r.cashflows) && r.cashflows.length
      ? r.cashflows.map((c: Row) => ({
          date: String(c.date).slice(0, 10),
          scheduledDate: c.scheduledDate ? String(c.scheduledDate).slice(0, 10) : undefined,
          interest: Number(c.interest ?? 0),
          principal: Number(c.principal ?? 0),
          recordDate: c.recordDate ? String(c.recordDate).slice(0, 10) : undefined,
        }))
      : undefined,
    listed: r.is_listed ?? undefined,
    source,
    verified: true,
  };
}

export class SnapeBondProvider implements BondDataProvider {
  readonly name = 'snape';
  constructor(private readonly db: Db) {}
  async getMany(isins: string[]) {
    const m = new Map<string, BondTerms>();
    if (!isins.length) return m;
    for (const r of await this.db.query<Row>(SNAPE_SQL.byIsins, [isins])) {
      try {
        const t = mapRow(r);
        m.set(t.isin, t);
      } catch (e) {
        console.warn(`[snape] skipping ${r.isin}: ${(e as Error).message}`);
      }
    }
    return m;
  }
  async search(q: string, limit: number) {
    const rows = await this.db.query<Row>(SNAPE_SQL.search, [q.trim(), limit]);
    return rows.flatMap((r) => {
      try {
        return [mapRow(r)];
      } catch {
        return [];
      }
    });
  }
}
