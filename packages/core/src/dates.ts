import type { ISODate } from './types';

const pad = (n: number) => String(n).padStart(2, '0');

export function parseISO(s: ISODate): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`Invalid ISO date: ${s}`);
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function toISO(d: Date): ISODate {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function addDays(s: ISODate, n: number): ISODate {
  const d = parseISO(s);
  d.setUTCDate(d.getUTCDate() + n);
  return toISO(d);
}

export function daysInMonth(y: number, m0: number): number {
  return new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
}

/**
 * Add calendar months, anchored to a day-of-month. If the anchor day does not
 * exist in the target month it clamps to the month end (31 Jan + 1M = 28/29 Feb),
 * and later steps go back to the anchor (28 Feb + 1M with anchor 31 = 31 Mar).
 */
export function addMonths(s: ISODate, k: number, anchorDay?: number): ISODate {
  const d = parseISO(s);
  const anchor = anchorDay ?? d.getUTCDate();
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + k;
  const y = Math.floor(total / 12);
  const m0 = total - y * 12;
  const day = Math.min(anchor, daysInMonth(y, m0));
  return `${y}-${pad(m0 + 1)}-${pad(day)}`;
}

export function diffDays(a: ISODate, b: ISODate): number {
  return Math.round((parseISO(b).getTime() - parseISO(a).getTime()) / 86_400_000);
}

export const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

export function dayOfWeek(s: ISODate): number {
  return parseISO(s).getUTCDay();
}

export const minDate = (a: ISODate, b: ISODate) => (a < b ? a : b);
export const maxDate = (a: ISODate, b: ISODate) => (a > b ? a : b);

/** Today's date in India (IST, UTC+05:30), which is the business calendar we care about. */
export function todayIST(now: Date = new Date()): ISODate {
  return toISO(new Date(now.getTime() + 330 * 60_000));
}

/** Holiday calendar: weekends plus a set of declared holidays (NSE/BSE settlement + RBI). */
export class HolidayCalendar {
  private readonly holidays: Set<ISODate>;
  constructor(holidays: Iterable<ISODate> = []) {
    this.holidays = new Set(holidays);
  }
  isBusinessDay(s: ISODate): boolean {
    const w = dayOfWeek(s);
    return w !== 0 && w !== 6 && !this.holidays.has(s);
  }
  /** Following: move forward to the next business day. Used for coupon dates. */
  next(s: ISODate): ISODate {
    let d = s;
    for (let i = 0; i < 15 && !this.isBusinessDay(d); i++) d = addDays(d, 1);
    return d;
  }
  /** Preceding: move back to the previous business day. Used for redemption dates. */
  prev(s: ISODate): ISODate {
    let d = s;
    for (let i = 0; i < 15 && !this.isBusinessDay(d); i++) d = addDays(d, -1);
    return d;
  }
}

export const WEEKENDS_ONLY = new HolidayCalendar();

/** Indian financial year label for a date, e.g. 2026-11-17 → "2026-27". */
export function financialYear(s: ISODate): string {
  const d = parseISO(s);
  const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}

export function fyRange(fy: string): { from: ISODate; to: ISODate } {
  const y = Number(fy.slice(0, 4));
  if (!/^\d{4}-\d{2}$/.test(fy) || Number.isNaN(y)) throw new Error(`Invalid FY: ${fy}`);
  return { from: `${y}-04-01`, to: `${y + 1}-03-31` };
}
