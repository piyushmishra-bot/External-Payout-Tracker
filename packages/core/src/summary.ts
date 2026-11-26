import { diffDays, financialYear, fyRange } from './dates';
import { allEvents, payoutStatus, round2 } from './schedule';
import type { HolidayCalendar } from './dates';
import type { HoldingWithTerms, ISODate, PayoutEvent } from './types';

export interface PortfolioSummary {
  holdingsCount: number;
  /** Outstanding face value today (units × face value, less any principal already repaid). */
  principal: number;
  /** What the user paid; falls back to principal where the purchase amount is unknown. */
  invested: number;
  /** Gross interest still to come (today onwards). */
  expectedInterest: number;
  /** Gross principal still to come. */
  expectedPrincipal: number;
  /** Interest falling in the current calendar month. */
  interestThisMonth: number;
  /** Principal-weighted average coupon. Always available. */
  avgCoupon: number;
  /** Indicative XIRR, only when every holding has a purchase amount and date. */
  xirr: number | null;
  nextPayout: PayoutEvent | null;
  /** Amount the user has marked received, across tracked payouts. */
  receivedTotal: number;
  /** Count of past payouts not yet marked received. */
  unconfirmedCount: number;
}

export function summarise(
  items: HoldingWithTerms[],
  today: ISODate,
  received: ReadonlySet<string> = new Set(),
  cal?: HolidayCalendar,
): PortfolioSummary {
  const ev = allEvents(items, cal);
  const fut = ev.filter((e) => e.date >= today);
  // Principal outstanding = principal still to be repaid on future events (handles amortising bonds),
  // plus holdings whose events are all filtered out but have not matured.
  const principalByHolding = new Map<string, number>();
  for (const h of items) principalByHolding.set(h.holding.id, 0);
  for (const e of fut) principalByHolding.set(e.holdingId, (principalByHolding.get(e.holdingId) ?? 0) + e.principal);
  for (const h of items) {
    if (!fut.some((e) => e.holdingId === h.holding.id) && h.terms.maturityDate >= today)
      principalByHolding.set(h.holding.id, h.holding.units * h.terms.faceValue);
  }
  const principal = round2([...principalByHolding.values()].reduce((s, v) => s + v, 0));
  const invested = round2(
    items.reduce(
      (s, h) => s + (h.holding.investedAmount ?? (principalByHolding.get(h.holding.id) ?? 0)),
      0,
    ),
  );
  const month = today.slice(0, 7);
  const weight = items.reduce((s, h) => s + h.holding.units * h.terms.faceValue, 0);
  const avgCoupon = weight
    ? items.reduce((s, h) => s + h.holding.units * h.terms.faceValue * h.terms.couponRate, 0) / weight
    : 0;

  let xirrValue: number | null = null;
  if (items.length && items.every((h) => h.holding.investedAmount && h.holding.acquiredOn)) {
    const flows: { date: ISODate; amount: number }[] = items.map((h) => ({
      date: h.holding.acquiredOn!,
      amount: -h.holding.investedAmount!,
    }));
    // Every payout since the purchase date counts toward the yield, including those before the bond was added here.
    const sincePurchase = allEvents(items.map((h) => ({ ...h, holding: { ...h.holding, trackedFrom: h.holding.acquiredOn! } })), cal);
    for (const e of sincePurchase) flows.push({ date: e.date, amount: e.amount });
    xirrValue = xirr(flows);
  }

  return {
    holdingsCount: items.length,
    principal,
    invested,
    expectedInterest: round2(fut.reduce((s, e) => s + e.interest, 0)),
    expectedPrincipal: round2(fut.reduce((s, e) => s + e.principal, 0)),
    interestThisMonth: round2(ev.filter((e) => e.date.startsWith(month)).reduce((s, e) => s + e.interest, 0)),
    avgCoupon: Math.round(avgCoupon * 100) / 100,
    xirr: xirrValue,
    nextPayout: fut.find((e) => !received.has(e.key)) ?? null,
    receivedTotal: round2(ev.filter((e) => received.has(e.key)).reduce((s, e) => s + e.amount, 0)),
    unconfirmedCount: ev.filter((e) => e.date < today && payoutStatus(e, today, received) === 'not_marked').length,
  };
}

/** Annualised internal rate of return for dated cash flows (Newton with bisection fallback). */
export function xirr(flows: { date: ISODate; amount: number }[]): number | null {
  if (!flows.some((f) => f.amount < 0) || !flows.some((f) => f.amount > 0)) return null;
  const t0 = flows.reduce((m, f) => (f.date < m ? f.date : m), flows[0].date);
  const ts = flows.map((f) => diffDays(t0, f.date) / 365);
  const npv = (r: number) => flows.reduce((s, f, i) => s + f.amount / Math.pow(1 + r, ts[i]), 0);
  let lo = -0.99;
  let hi = 10;
  if (npv(lo) * npv(hi) > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (npv(lo) * npv(mid) <= 0) hi = mid;
    else lo = mid;
    if (hi - lo < 1e-9) break;
  }
  return Math.round(((lo + hi) / 2) * 10000) / 100;
}

export type RatingBucket = 'AAA' | 'AA' | 'A' | 'BBB' | 'Below BBB' | 'Unrated';

export function ratingBucket(r?: string): RatingBucket {
  const s = (r ?? '').toUpperCase().replace(/\s|\(.*\)/g, '').replace(/^(CRISIL|ICRA|CARE|IND|INDIA|BWR|ACUITE|IVR)/, '');
  if (!s || s === 'NR' || s === 'UNRATED') return 'Unrated';
  if (s.startsWith('AAA') || s === 'SOVEREIGN') return 'AAA';
  if (s.startsWith('AA')) return 'AA';
  if (s.startsWith('A')) return 'A';
  if (s.startsWith('BBB')) return 'BBB';
  return 'Below BBB';
}

export interface PortfolioReport {
  ratingMix: { bucket: RatingBucket; principal: number; share: number }[];
  issuers: { issuer: string; principal: number; share: number }[];
  maturityLadder: { year: number; principal: number }[];
  frequencyMix: { label: string; principal: number }[];
  /** Principal by issuer sector (NBFC, Housing finance…); "Other" when the sector is not known. */
  sectorMix: { sector: string; principal: number; share: number }[];
  /** Principal by exact rating (AA-, A+…), best first. */
  gradeMix: { grade: string; principal: number; share: number }[];
  /** Plain-language flags, e.g. one issuer over 25% of principal. */
  flags: string[];
}

const FREQ_LABEL: Record<number, string> = { 12: 'Monthly', 4: 'Quarterly', 2: 'Half-yearly', 1: 'Yearly', 0: 'At maturity' };

export function portfolioReport(items: HoldingWithTerms[]): PortfolioReport {
  const fv = (h: HoldingWithTerms) => h.holding.units * h.terms.faceValue;
  const total = items.reduce((s, h) => s + fv(h), 0) || 1;
  const group = <K extends string | number>(key: (h: HoldingWithTerms) => K) => {
    const m = new Map<K, number>();
    for (const h of items) m.set(key(h), (m.get(key(h)) ?? 0) + fv(h));
    return m;
  };
  const order: RatingBucket[] = ['AAA', 'AA', 'A', 'BBB', 'Below BBB', 'Unrated'];
  const rm = group((h) => ratingBucket(h.terms.rating));
  const im = group((h) => h.terms.issuer);
  const ym = group((h) => Number(h.terms.maturityDate.slice(0, 4)));
  const fm = group((h) => FREQ_LABEL[h.terms.frequency]);
  const sm = group((h) => h.terms.sector || 'Other');
  const gm = group((h) => (h.terms.rating || 'Unrated').replace(/^(CRISIL|ICRA|CARE|IND|ACUITE|BWR)\s*/i, '').toUpperCase());
  const GRADES = ['AAA', 'AA+', 'AA', 'AA-', 'A+', 'A', 'A-', 'BBB+', 'BBB', 'BBB-', 'BB+', 'BB', 'BB-', 'B', 'C', 'D', 'UNRATED'];
  const gi = (g: string) => (GRADES.indexOf(g) < 0 ? 99 : GRADES.indexOf(g));
  const issuers = [...im.entries()]
    .map(([issuer, principal]) => ({ issuer, principal, share: principal / total }))
    .sort((a, b) => b.principal - a.principal);
  const flags: string[] = [];
  if (issuers[0] && issuers[0].share > 0.25 && items.length > 1)
    flags.push(`${issuers[0].issuer} is ${Math.round(issuers[0].share * 100)}% of your principal.`);
  const low = (rm.get('BBB') ?? 0) + (rm.get('Below BBB') ?? 0) + (rm.get('Unrated') ?? 0);
  if (low / total > 0.3) flags.push(`${Math.round((low / total) * 100)}% of your principal is rated BBB or lower, or unrated.`);
  return {
    ratingMix: order.filter((b) => rm.has(b)).map((bucket) => ({ bucket, principal: rm.get(bucket)!, share: rm.get(bucket)! / total })),
    issuers,
    maturityLadder: [...ym.entries()].sort((a, b) => a[0] - b[0]).map(([year, principal]) => ({ year, principal })),
    frequencyMix: [...fm.entries()].map(([label, principal]) => ({ label, principal })),
    sectorMix: [...sm.entries()].map(([sector, principal]) => ({ sector, principal, share: principal / total })).sort((a, b) => b.principal - a.principal),
    gradeMix: [...gm.entries()].map(([grade, principal]) => ({ grade: grade === 'UNRATED' ? 'Unrated' : grade, principal, share: principal / total })).sort((a, b) => gi(a.grade.toUpperCase()) - gi(b.grade.toUpperCase())),
    flags,
  };
}

export interface TaxStatementRow {
  date: ISODate;
  isin: string;
  bondName: string;
  portfolioId: string;
  grossInterest: number;
  /** Indicative TDS at 10% (Section 193) for resident individuals; actual TDS depends on Form 15G/15H and issuer. */
  indicativeTds: number;
  received: boolean;
}

export function taxStatement(
  items: HoldingWithTerms[],
  fy: string = financialYear(new Date().toISOString().slice(0, 10)),
  received: ReadonlySet<string> = new Set(),
  cal?: HolidayCalendar,
): { fy: string; rows: TaxStatementRow[]; totalInterest: number; totalTds: number } {
  const { from, to } = fyRange(fy);
  const rows = allEvents(items, cal, { from, to })
    .filter((e) => e.interest > 0)
    .map((e) => ({
      date: e.date,
      isin: e.isin,
      bondName: e.bondName,
      portfolioId: e.portfolioId,
      grossInterest: e.interest,
      indicativeTds: round2(e.interest * 0.1),
      received: received.has(e.key),
    }));
  return {
    fy,
    rows,
    totalInterest: round2(rows.reduce((s, r) => s + r.grossInterest, 0)),
    totalTds: round2(rows.reduce((s, r) => s + r.indicativeTds, 0)),
  };
}
