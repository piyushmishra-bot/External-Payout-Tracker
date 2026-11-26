import { isValidIsin, type CouponType, type Frequency, type UnitCashflow } from '@eh/core';
import type { DirectoryRow } from '../services/directory';

/**
 * Reads BondScanner's live bonds from bondscanner.com, the same way its own pages do:
 *   1. GET {api}/v1/issuer/isins?page=N           → the live list (ISIN, deal id, name, rating, …), 10 per page
 *   2. GET {site}/_next/data/{buildId}/deal-details/{isin}/{id}.json
 *                                                  → full terms + the issuer's payout schedule per unit
 * buildId is the site's current release id (in every page's HTML); it changes on each deploy, so it is
 * read at the start and re-read once if a detail request 404s mid-run.
 *
 * These are bondscanner.com's internal endpoints, not a published API. Replace with a stable internal
 * endpoint from the BondScanner team when one is available; only this file needs to change.
 */
export interface BondScannerSyncOptions {
  api?: string;
  site?: string;
  /** Pause between detail requests, to stay gentle on the site. */
  delayMs?: number;
  maxPages?: number;
  fetch?: typeof fetch;
  log?: (msg: string) => void;
}
export interface BondScannerSyncResult {
  listed: number;
  bonds: DirectoryRow[];
  problems: { isin: string; message: string }[];
}

type ListItem = { ID: string; isin: string; issuerName: string; ratings?: string; payoutFrequency?: string; maturityDate?: string };

const FREQ: Record<string, Frequency> = {
  monthly: 12, quarterly: 4, halfyearly: 2, semiannual: 2, semiannually: 2, annual: 1, annually: 1, yearly: 1,
  atmaturity: 0, onmaturity: 0, cumulative: 0, zerocoupon: 0, none: 0,
};
const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
/** "2031-03-15T05:30:00+05:30" → "2031-03-15" (dates are given in IST). */
const day = (s: unknown) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : undefined);
const money = (v: unknown) => Math.round(Number(String(v ?? '').replace(/[₹,\s]/g, '')) * 100) / 100;

/** Same day of month, n months earlier (clamped to the month's last day). */
function monthsBack(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 - n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/**
 * bondscanner.com lists only the payouts a buyer today would still receive (from the next record date on).
 * Holders who bought earlier also got the coupons before that, so we add them: same day of month, every
 * 12/frequency months back to the issue date (at most 10 years), each one regular coupon (face value ×
 * coupon ÷ frequency). Only for plain coupon bonds with no principal paid back before the first listed date.
 */
export function backfillCoupons(flows: UnitCashflow[], o: { frequency: Frequency; couponRate: number; faceValue: number; issueDate?: string }): UnitCashflow[] {
  if (!flows.length || !(o.frequency > 0) || !(o.couponRate > 0)) return flows;
  const step = 12 / o.frequency;
  if (!Number.isInteger(step)) return flows;
  const per = Math.round(((o.faceValue * o.couponRate) / 100 / o.frequency) * 100) / 100;
  const floor = o.issueDate ?? monthsBack(flows[0].date, 120);
  const earlier: UnitCashflow[] = [];
  for (let k = 1; k <= 120 / step; k++) {
    const date = monthsBack(flows[0].date, k * step);
    if (date <= floor) break;
    earlier.unshift({ date, interest: per, principal: 0 });
  }
  return [...earlier, ...flows];
}

/** Maps one bond's page data to a directory row. Throws with a readable reason when something essential is missing. */
export function mapDealDetails(item: ListItem, pageProps: any): DirectoryRow {
  const d = pageProps?.bondDealData;
  if (!d) throw new Error('no bond data on the page');
  const isin = String(item.isin).toUpperCase();
  if (!isValidIsin(isin)) throw new Error(`invalid ISIN ${isin}`);
  const name: string = (d.basicDetails?.issuerName || item.issuerName || '').trim();
  if (!name) throw new Error('no name');
  const faceValue = money(d.isinDetails?.faceValue);
  if (!(faceValue > 0)) throw new Error('no face value');
  const maturityDate = day(d.isinDetails?.maturityDate) ?? day(item.maturityDate);
  if (!maturityDate) throw new Error('no maturity date');
  const couponRate = Number(d.coupons?.couponRate);
  if (!(couponRate >= 0)) throw new Error('no coupon rate');
  const fqText = d.coupons?.payoutFrequency ?? d.payoutSchedule?.interestPayoutFrequency ?? item.payoutFrequency;
  let frequency = FREQ[norm(fqText)];
  if (frequency === undefined) throw new Error(`unknown payout frequency "${fqText}"`);
  const ct = norm(d.coupons?.couponType);
  let couponType: CouponType = ct.includes('zero') ? 'zero' : ct.includes('cumulative') ? 'cumulative' : ct.includes('float') ? 'floating' : 'fixed';
  if (couponRate === 0) couponType = 'zero';
  if (couponType === 'zero' || couponType === 'cumulative') frequency = 0;

  const cashflows: UnitCashflow[] = (d.payoutSchedule?.data ?? [])
    .map((r: any) => ({ date: day(r.date)!, interest: money(r.interest), principal: money(r.principal) }))
    .filter((r: UnitCashflow) => r.date && (r.interest > 0 || r.principal > 0));
  const last = cashflows.at(-1);
  const issueDate = day(d.isinDetails?.dateOfIssuance);
  const withHistory = frequency > 0 ? backfillCoupons(cashflows, { frequency, couponRate, faceValue, issueDate }) : cashflows;

  return {
    isin,
    name,
    // "UGRO Capital Mar ’31" → issuer "UGRO Capital"
    issuer: name.replace(/\s+[A-Za-z]{3}\s*['’]\s?\d{2}$/, '') || name,
    faceValue,
    couponRate,
    frequency,
    couponType,
    dayCount: 'ACT/ACT',
    issueDate,
    maturityDate,
    rating: d.rating?.rating || item.ratings || undefined,
    ratingAgency: d.rating?.ratingAgency || undefined,
    maturityAmount: frequency === 0 && last ? Math.round((last.interest + last.principal) * 100) / 100 : undefined,
    cashflows: withHistory.length ? withHistory : undefined,
    securityType: pageProps?.isGovernmentBond ? 'gsec' : 'ncd',
    listed: true,
    source: 'bondscanner',
    verified: true,
    note: d.isinDetails?.seniority ? `BondScanner · ${d.isinDetails.seniority}` : 'BondScanner',
    externalId: item.ID,
  };
}

export async function fetchBondScannerBonds(o: BondScannerSyncOptions = {}): Promise<BondScannerSyncResult> {
  const api = (o.api ?? 'https://loom.bondscanner.com').replace(/\/$/, '');
  const site = (o.site ?? 'https://bondscanner.com').replace(/\/$/, '');
  const f = o.fetch ?? fetch;
  const log = o.log ?? (() => undefined);
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const headers = { accept: 'application/json', 'user-agent': 'bond-portfolio-directory-sync' };

  const items: ListItem[] = [];
  for (let page = 0; page < (o.maxPages ?? 50); page++) {
    const r = await f(`${api}/v1/issuer/isins?page=${page}`, { headers });
    if (!r.ok) throw new Error(`bond list page ${page}: HTTP ${r.status}`);
    const j: any = await r.json();
    items.push(...(j.data ?? []));
    if (!j.pageInfo?.hasNext) break;
  }
  const seen = new Set<string>();
  const unique = items.filter((i) => i?.isin && i?.ID && !seen.has(i.isin) && seen.add(i.isin));
  log(`List: ${unique.length} live bonds`);

  const readBuildId = async () => {
    const html = await (await f(`${site}/bonds`, { headers: { 'user-agent': headers['user-agent'] } })).text();
    const m = /"buildId":"([^"]+)"/.exec(html);
    if (!m) throw new Error('could not find the site build id on /bonds');
    return m[1];
  };
  let buildId = await readBuildId();

  const bonds: DirectoryRow[] = [];
  const problems: BondScannerSyncResult['problems'] = [];
  for (const [n, item] of unique.entries()) {
    const url = () => `${site}/_next/data/${buildId}/deal-details/${encodeURIComponent(item.isin)}/${encodeURIComponent(item.ID)}.json`;
    try {
      let r = await f(url(), { headers });
      if (r.status === 404) {
        buildId = await readBuildId(); // the site was redeployed during the run
        r = await f(url(), { headers });
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      bonds.push(mapDealDetails(item, ((await r.json()) as any).pageProps));
    } catch (e) {
      problems.push({ isin: item.isin, message: (e as Error).message });
    }
    if ((n + 1) % 25 === 0) log(`Details: ${n + 1}/${unique.length}`);
    if (o.delayMs ?? 150) await wait(o.delayMs ?? 150);
  }
  return { listed: unique.length, bonds, problems };
}
