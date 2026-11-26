import {
  addDays,
  addMonths,
  diffDays,
  HolidayCalendar,
  isLeap,
  maxDate,
  parseISO,
  WEEKENDS_ONLY,
} from './dates';
import type {
  BondTerms,
  HoldingWithTerms,
  ISODate,
  PayoutEvent,
  PayoutStatus,
  UnitCashflow,
} from './types';

export const DEFAULT_RECORD_DATE_OFFSET = 15;

/**
 * Year fraction under ACT/ACT as SEBI prescribes for listed NCDs: each day in the
 * period is weighted by 1/365, or 1/366 if it falls in a leap year.
 */
export function yearFractionActAct(from: ISODate, to: ISODate): number {
  if (to <= from) return 0;
  let frac = 0;
  let cursor = from;
  while (cursor < to) {
    const y = parseISO(cursor).getUTCFullYear();
    const yearEnd = `${y + 1}-01-01`;
    const segEnd = yearEnd < to ? yearEnd : to;
    frac += diffDays(cursor, segEnd) / (isLeap(y) ? 366 : 365);
    cursor = segEnd;
  }
  return frac;
}

export function yearFraction30360(from: ISODate, to: ISODate): number {
  const a = parseISO(from);
  const b = parseISO(to);
  const d1 = Math.min(a.getUTCDate(), 30);
  const d2 = Math.min(b.getUTCDate(), 30);
  const days =
    360 * (b.getUTCFullYear() - a.getUTCFullYear()) + 30 * (b.getUTCMonth() - a.getUTCMonth()) + (d2 - d1);
  return days / 360;
}

/** Unadjusted coupon dates, from the first after issue (or after `from`) through maturity. */
export function couponDates(terms: BondTerms, from?: ISODate): ISODate[] {
  if (terms.frequency === 0) return [terms.maturityDate];
  const step = 12 / terms.frequency;
  const anchor = parseISO(terms.maturityDate).getUTCDate();
  // Without an issue date, assume at most a 30-year bond; holdings filter older flows anyway.
  const floor = maxDate(terms.issueDate ?? addMonths(terms.maturityDate, -360), from ?? '1900-01-01');
  const out: ISODate[] = [];
  for (let k = 0; k < 2400; k++) {
    const d = addMonths(terms.maturityDate, -k * step, anchor);
    if (d <= floor) break;
    out.push(d);
  }
  return out.reverse();
}

function outstandingBefore(terms: BondTerms, date: ISODate): number {
  const repaid = (terms.redemptions ?? []).filter((r) => r.date < date).reduce((s, r) => s + r.principal, 0);
  return Math.max(0, terms.faceValue - repaid);
}

/**
 * Per-unit cash flows for a bond. Vendor schedules win when present. Otherwise we
 * build one from the terms using SEBI conventions:
 *  - a coupon falling on a holiday is paid the next working day, amount unchanged;
 *  - redemption falling on a holiday is paid the previous working day, with interest
 *    accrued up to that day.
 */
export function unitCashflows(terms: BondTerms, cal: HolidayCalendar = WEEKENDS_ONLY): UnitCashflow[] {
  const offset = terms.recordDateOffsetDays ?? DEFAULT_RECORD_DATE_OFFSET;
  if (terms.cashflows?.length) {
    return [...terms.cashflows]
      .map((c) => ({ ...c, scheduledDate: c.scheduledDate ?? c.date, recordDate: c.recordDate ?? addDays(c.date, -offset) }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  // Zero coupon / cumulative: one payment at maturity.
  if (terms.frequency === 0 || terms.couponType === 'zero' || terms.couponType === 'cumulative') {
    const date = cal.prev(terms.maturityDate);
    const total = terms.maturityAmount ?? terms.faceValue;
    return [
      {
        date,
        scheduledDate: terms.maturityDate,
        recordDate: addDays(date, -offset),
        principal: terms.faceValue,
        interest: Math.max(0, total - terms.faceValue),
      },
    ];
  }

  const dates = couponDates(terms);
  const redemptionDates = new Set((terms.redemptions ?? []).map((r) => r.date));
  // Staggered redemptions that are not coupon dates still need a payment row.
  for (const r of terms.redemptions ?? []) if (!dates.includes(r.date)) dates.push(r.date);
  dates.sort();

  const firstStart =
    terms.issueDate ?? addMonths(dates[0], -12 / terms.frequency, parseISO(terms.maturityDate).getUTCDate());
  const rate = terms.couponRate / 100;
  const flows: UnitCashflow[] = [];
  let prevEnd = firstStart;

  for (const sched of dates) {
    const isFinal = sched === terms.maturityDate;
    const payDate = isFinal ? cal.prev(sched) : cal.next(sched);
    const accrualEnd = isFinal ? payDate : sched;
    const outstanding = outstandingBefore(terms, sched);
    let interest: number;
    switch (terms.dayCount) {
      case 'EQUAL':
        interest = (outstanding * rate) / terms.frequency;
        break;
      case '30/360':
        interest = outstanding * rate * yearFraction30360(prevEnd, accrualEnd);
        break;
      default:
        interest = outstanding * rate * yearFractionActAct(prevEnd, accrualEnd);
    }
    let principal = 0;
    if (isFinal) principal = outstanding;
    else if (redemptionDates.has(sched)) principal = (terms.redemptions ?? []).find((r) => r.date === sched)!.principal;
    flows.push({
      date: payDate,
      scheduledDate: sched,
      recordDate: addDays(payDate, -offset),
      interest: round2(interest),
      principal: round2(principal),
    });
    prevEnd = sched;
  }
  return flows;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

export interface EventWindow {
  from?: ISODate;
  to?: ISODate;
}

/** Payout events for one holding: unit flows × units, bounded by tracking and purchase dates. */
export function holdingEvents(h: HoldingWithTerms, cal?: HolidayCalendar, window: EventWindow = {}): PayoutEvent[] {
  const { holding, terms, portfolio } = h;
  const flows = unitCashflows(terms, cal);
  const lastDate = flows.length ? flows[flows.length - 1].date : terms.maturityDate;
  return flows
    .filter((f) => f.date >= holding.trackedFrom)
    .filter((f) => !holding.acquiredOn || (f.recordDate ?? f.date) >= holding.acquiredOn)
    .filter((f) => (!window.from || f.date >= window.from) && (!window.to || f.date <= window.to))
    .map((f) => {
      const interest = round2(f.interest * holding.units);
      const principal = round2(f.principal * holding.units);
      return {
        key: `${holding.id}|${f.scheduledDate ?? f.date}`,
        holdingId: holding.id,
        portfolioId: portfolio.id,
        isin: terms.isin,
        bondName: terms.name,
        date: f.date,
        scheduledDate: f.scheduledDate ?? f.date,
        recordDate: f.recordDate ?? f.date,
        interest,
        principal,
        amount: round2(interest + principal),
        isFinal: f.date === lastDate,
        verified: terms.verified,
        estimated: !terms.verified || (!terms.cashflows?.length && !terms.issueDate),
        frequency: terms.frequency,
      };
    });
}

export function allEvents(items: HoldingWithTerms[], cal?: HolidayCalendar, window?: EventWindow): PayoutEvent[] {
  return items
    .flatMap((h) => holdingEvents(h, cal, window))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.bondName.localeCompare(b.bondName)));
}

/**
 * Status shown on a payout. We cannot see the user's bank account, so "received"
 * only ever comes from the user marking it.
 */
export function payoutStatus(e: PayoutEvent, today: ISODate, received: ReadonlySet<string>): PayoutStatus {
  if (received.has(e.key)) return 'received';
  if (e.date > today) return 'upcoming';
  if (e.date === today) return 'due_today';
  return diffDays(e.date, today) >= 2 ? 'not_marked' : 'awaiting_credit';
}

export const STATUS_LABEL: Record<PayoutStatus, string> = {
  upcoming: 'Upcoming',
  due_today: 'Due today',
  awaiting_credit: 'Awaiting credit',
  not_marked: 'Not marked received',
  received: 'Received',
};

/**
 * Payouts on bonds bought through BondScanner are paid into accounts BondScanner
 * already tracks, so past ones count as received without the user marking them.
 */
export function withAutoReceived(items: HoldingWithTerms[], today: ISODate, received: ReadonlySet<string>, cal?: HolidayCalendar): Set<string> {
  const out = new Set(received);
  for (const h of items) {
    if (h.portfolio.source !== 'bondscanner') continue;
    for (const e of holdingEvents(h, cal, { to: today })) if (e.date < today) out.add(e.key);
  }
  return out;
}
