import { HolidayCalendar, type BondTerms } from '@eh/core';
import { isoDate, type Db } from '../db';
import type { BondDataProvider } from '../providers/types';

type CacheRow = Record<string, any>;

function fromCache(r: CacheRow): BondTerms {
  return {
    isin: r.isin,
    name: r.name,
    issuer: r.issuer,
    faceValue: Number(r.face_value),
    couponRate: Number(r.coupon_rate),
    frequency: Number(r.frequency) as BondTerms['frequency'],
    couponType: r.coupon_type,
    dayCount: r.day_count,
    issueDate: r.issue_date ? isoDate(r.issue_date) : undefined,
    maturityDate: isoDate(r.maturity_date),
    rating: r.rating ?? undefined,
    ratingAgency: r.rating_agency ?? undefined,
    recordDateOffsetDays: r.record_date_offset ?? undefined,
    maturityAmount: r.maturity_amount != null ? Number(r.maturity_amount) : undefined,
    redemptions: r.redemptions ?? undefined,
    cashflows: r.cashflows ?? undefined,
    securityType: r.security_type ?? undefined,
    listed: r.listed ?? undefined,
    source: r.source,
    verified: true,
  };
}

/**
 * Looks up bond terms: local cache first, then each provider in order
 * (SNAPE, then Deridata). Results are written back to the cache.
 */
export class BondService {
  constructor(
    private readonly db: Db,
    private readonly providers: BondDataProvider[],
    private readonly ttlHours = 24,
  ) {}

  async getMany(isinsIn: string[]): Promise<Map<string, BondTerms>> {
    const isins = [...new Set(isinsIn.map((s) => s.toUpperCase()))];
    const out = new Map<string, BondTerms>();
    if (!isins.length) return out;
    const cached = await this.db.query<CacheRow>(
      `SELECT * FROM eh_bond_master WHERE isin = ANY($1) AND fetched_at > now() - ($2 || ' hours')::interval`,
      [isins, String(this.ttlHours)],
    );
    for (const r of cached) out.set(r.isin, fromCache(r));
    let missing = isins.filter((i) => !out.has(i));
    for (const p of this.providers) {
      if (!missing.length) break;
      try {
        const got = await p.getMany(missing);
        for (const [k, v] of got) {
          out.set(k, v);
          await this.upsert(v);
        }
      } catch (e) {
        console.warn(`[bonds] provider ${p.name} failed: ${(e as Error).message}`);
      }
      missing = missing.filter((i) => !out.has(i));
    }
    // Stale cache is better than nothing if every provider failed.
    if (missing.length) {
      const stale = await this.db.query<CacheRow>(`SELECT * FROM eh_bond_master WHERE isin = ANY($1)`, [missing]);
      for (const r of stale) out.set(r.isin, fromCache(r));
    }
    return out;
  }

  /** Force a fresh fetch (used by the 6-hourly sync), skipping the cache. Returns ISINs refreshed. */
  async refresh(isinsIn: string[]): Promise<string[]> {
    let missing = [...new Set(isinsIn.map((s) => s.toUpperCase()))];
    const done: string[] = [];
    for (const p of this.providers) {
      if (!missing.length) break;
      try {
        const got = await p.getMany(missing);
        for (const [k, v] of got) {
          await this.upsert(v);
          done.push(k);
        }
      } catch (e) {
        console.warn(`[bonds] refresh via ${p.name} failed: ${(e as Error).message}`);
      }
      missing = missing.filter((i) => !done.includes(i));
    }
    return done;
  }

  async search(q: string, limit = 8): Promise<BondTerms[]> {
    const seen = new Map<string, BondTerms>();
    for (const p of this.providers) {
      if (seen.size >= limit) break;
      try {
        for (const b of await p.search(q, limit)) if (!seen.has(b.isin)) seen.set(b.isin, b);
      } catch (e) {
        console.warn(`[bonds] search on ${p.name} failed: ${(e as Error).message}`);
      }
    }
    return [...seen.values()].slice(0, limit);
  }

  async upsert(t: BondTerms) {
    await this.db.query(
      `INSERT INTO eh_bond_master (isin, name, issuer, face_value, coupon_rate, frequency, coupon_type, day_count,
         issue_date, maturity_date, rating, rating_agency, record_date_offset, maturity_amount, redemptions, cashflows,
         security_type, listed, source, fetched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19, now())
       ON CONFLICT (isin) DO UPDATE SET name=EXCLUDED.name, issuer=EXCLUDED.issuer, face_value=EXCLUDED.face_value,
         coupon_rate=EXCLUDED.coupon_rate, frequency=EXCLUDED.frequency, coupon_type=EXCLUDED.coupon_type,
         day_count=EXCLUDED.day_count, issue_date=EXCLUDED.issue_date, maturity_date=EXCLUDED.maturity_date,
         rating=EXCLUDED.rating, rating_agency=EXCLUDED.rating_agency, record_date_offset=EXCLUDED.record_date_offset,
         maturity_amount=EXCLUDED.maturity_amount, redemptions=EXCLUDED.redemptions, cashflows=EXCLUDED.cashflows,
         security_type=EXCLUDED.security_type, listed=EXCLUDED.listed, source=EXCLUDED.source, fetched_at=now()`,
      [
        t.isin, t.name, t.issuer, t.faceValue, t.couponRate, t.frequency, t.couponType, t.dayCount,
        t.issueDate ?? null, t.maturityDate, t.rating ?? null, t.ratingAgency ?? null, t.recordDateOffsetDays ?? null,
        t.maturityAmount ?? null, t.redemptions ? JSON.stringify(t.redemptions) : null,
        t.cashflows ? JSON.stringify(t.cashflows) : null, t.securityType ?? null, t.listed ?? null, t.source,
      ],
    );
  }
}

/** Holiday calendar from eh_market_holidays, cached in memory for an hour. */
export class CalendarService {
  private cache: { at: number; cal: HolidayCalendar } | null = null;
  constructor(private readonly db: Db) {}
  async get(): Promise<HolidayCalendar> {
    if (this.cache && Date.now() - this.cache.at < 3_600_000) return this.cache.cal;
    const rows = await this.db.query<{ holiday_date: string }>(
      `SELECT holiday_date FROM eh_market_holidays WHERE calendar = 'NSE_SETTLEMENT'`,
    );
    const cal = new HolidayCalendar(rows.map((r) => isoDate(r.holiday_date)));
    this.cache = { at: Date.now(), cal };
    return cal;
  }
}
