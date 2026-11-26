import type { BondTerms } from '@eh/core';
import { mapRow } from './snape';
import type { BondDataProvider } from './types';

/**
 * Deridata REST API. Used only for ISINs missing from SNAPE (newly listed bonds).
 *
 * ⚠️  CONFIRM BEFORE USE. Endpoint paths, auth header and field names are
 * placeholders until we have Deridata's API documentation and a key.
 * Edit PATHS, the auth header and toRow() only.
 */
const PATHS = {
  bond: (isin: string) => `/v1/bonds/${encodeURIComponent(isin)}`,
  cashflows: (isin: string) => `/v1/bonds/${encodeURIComponent(isin)}/cashflows`,
  search: (q: string, limit: number) => `/v1/bonds/search?q=${encodeURIComponent(q)}&limit=${limit}`,
};

/** Map Deridata's JSON to the same row shape SNAPE uses, so mapRow() is shared. */
function toRow(j: any, cashflows?: any[]): Record<string, unknown> {
  return {
    isin: j.isin,
    security_name: j.securityName ?? j.name,
    issuer_name: j.issuerName ?? j.issuer,
    face_value: j.faceValue,
    coupon_rate: j.couponRate,
    interest_frequency: j.interestPaymentFrequency ?? j.frequency,
    coupon_type: j.couponType,
    day_count_convention: j.dayCountConvention,
    allotment_date: j.allotmentDate ?? j.issueDate,
    maturity_date: j.maturityDate,
    credit_rating: j.rating?.grade ?? j.rating,
    rating_agency: j.rating?.agency ?? j.ratingAgency,
    record_date_days: j.recordDateDays,
    redemption_amount: j.redemptionAmount,
    is_listed: j.listed,
    sector: j.sector ?? j.industry, // TODO(BondScanner): confirm field name
    cashflows: cashflows?.map((c) => ({ date: c.paymentDate, scheduledDate: c.dueDate, interest: c.interest, principal: c.principal, recordDate: c.recordDate })),
  };
}

export class DeridataBondProvider implements BondDataProvider {
  readonly name = 'deridata';
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs = 8000,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async get(path: string): Promise<any | null> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(this.baseUrl.replace(/\/$/, '') + path, {
        headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
        signal: ctl.signal,
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Deridata ${res.status} for ${path}`);
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }

  async getMany(isins: string[]) {
    const m = new Map<string, BondTerms>();
    // Deridata is a paid API: call it per missing ISIN only, with small concurrency.
    const queue = [...isins];
    const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) {
        const isin = queue.shift()!;
        try {
          const j = await this.get(PATHS.bond(isin));
          if (!j) continue;
          const cf = await this.get(PATHS.cashflows(isin)).catch(() => null);
          const t = mapRow(toRow(j, Array.isArray(cf) ? cf : cf?.items), 'deridata');
          m.set(t.isin, t);
        } catch (e) {
          console.warn(`[deridata] ${isin}: ${(e as Error).message}`);
        }
      }
    });
    await Promise.all(workers);
    return m;
  }

  async search(q: string, limit: number) {
    const j = await this.get(PATHS.search(q, limit)).catch(() => null);
    const items: any[] = Array.isArray(j) ? j : j?.items ?? [];
    return items.flatMap((x) => {
      try {
        return [mapRow(toRow(x), 'deridata')];
      } catch {
        return [];
      }
    });
  }
}
