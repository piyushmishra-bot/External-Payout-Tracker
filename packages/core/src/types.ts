/**
 * Domain types for External Holdings.
 * Dates are ISO calendar strings (YYYY-MM-DD). Money is in rupees as numbers;
 * round only at display time.
 */

export type ISODate = string;

/** Coupons a year. 0 = no periodic coupon (zero coupon / cumulative, paid at maturity). */
export type Frequency = 0 | 1 | 2 | 4 | 12;

export type DayCount =
  /** SEBI convention for listed NCDs: actual days / actual days in that year (365 or 366). */
  | 'ACT/ACT'
  /** 30/360 European. Some PSU and older bonds. */
  | '30/360'
  /** Equal coupons: rate / frequency. Matches many term sheets' "indicative" coupon tables. */
  | 'EQUAL';

export type CouponType = 'fixed' | 'floating' | 'zero' | 'cumulative';

export type DataSource = 'snape' | 'deridata' | 'horizon' | 'fixture' | 'user' | 'directory' | 'bondscanner';

/** One cash flow for a single unit of a bond, as published by the vendor. */
export interface UnitCashflow {
  /** Date the money is expected in the investor's bank account (already holiday adjusted). */
  date: ISODate;
  /** Original scheduled date before holiday adjustment, if the vendor gives it. */
  scheduledDate?: ISODate;
  interest: number;
  principal: number;
  /** Record date for this flow, if known. */
  recordDate?: ISODate;
}

export interface Redemption {
  date: ISODate;
  /** Principal repaid per unit on this date. */
  principal: number;
}

/** Bond master record. Comes from SNAPE / Deridata, or from the user's own entry. */
export interface BondTerms {
  isin: string;
  /** Display name, e.g. "Aster Finance Aug ’28". */
  name: string;
  issuer: string;
  faceValue: number;
  /** Annual coupon in percent, e.g. 10.25. */
  couponRate: number;
  frequency: Frequency;
  couponType: CouponType;
  dayCount: DayCount;
  issueDate?: ISODate;
  maturityDate: ISODate;
  rating?: string;
  ratingAgency?: string;
  /** Days between record date and payment date. SEBI default for listed debt is 15. */
  recordDateOffsetDays?: number;
  /** Staggered principal repayments per unit. If absent, full face value at maturity. */
  redemptions?: Redemption[];
  /** For zero-coupon / cumulative bonds: amount paid per unit at maturity (principal + interest). */
  maturityAmount?: number;
  /** Vendor-published schedule per unit. Preferred over generated schedule when present. */
  cashflows?: UnitCashflow[];
  source: DataSource;
  /** False for user-entered terms; payouts derived from them are shown as Unverified. */
  verified: boolean;
  /** Listed on an exchange (NSE/BSE). */
  listed?: boolean;
  /** Security type for filtering imports: bonds/NCDs/G-secs/SDLs/T-bills etc. */
  /** Issuer sector, e.g. NBFC, Housing finance, MFI, Power. From SNAPE/Deridata when available. */
  sector?: string;
  securityType?: 'ncd' | 'bond' | 'gsec' | 'sdl' | 'tbill' | 'cp' | 'cd' | 'other';
}

export type PortfolioSource = 'bondscanner' | 'external';

export interface Holding {
  id: string;
  portfolioId: string;
  isin: string;
  units: number;
  /** What the user paid in total, if they told us. Used for invested amount and XIRR. */
  investedAmount?: number;
  /** Date the user bought it, if known. Payouts with a record date before this are excluded. */
  acquiredOn?: ISODate;
  /** Yield at purchase, % a year, if the user told us. */
  purchaseYield?: number;
  /** Date this holding started being tracked in BondScanner. Earlier payouts are not listed. */
  trackedFrom: ISODate;
}

export interface Portfolio {
  id: string;
  userId: string;
  name: string;
  source: PortfolioSource;
  createdAt: string;
  holdings: Holding[];
}

export type PayoutKind = 'interest' | 'principal' | 'interest+principal';

/** A payout the user should receive for a holding. */
export interface PayoutEvent {
  /** Stable key: holdingId|scheduledDate. Used for "mark received" and reminders. */
  key: string;
  holdingId: string;
  portfolioId: string;
  isin: string;
  bondName: string;
  /** Expected credit date (business-day adjusted). */
  date: ISODate;
  /** Scheduled date from the term sheet, before adjustment. */
  scheduledDate: ISODate;
  recordDate: ISODate;
  interest: number;
  principal: number;
  amount: number;
  isFinal: boolean;
  verified: boolean;
  /** True when amounts are worked out from incomplete terms (user-entered, or no issue date and no vendor schedule). */
  estimated: boolean;
  frequency: Frequency;
}

export type PayoutStatus =
  | 'upcoming'
  | 'due_today'
  | 'awaiting_credit'
  | 'not_marked'
  | 'received';

export interface HoldingWithTerms {
  holding: Holding;
  portfolio: Pick<Portfolio, 'id' | 'name' | 'source'>;
  terms: BondTerms;
}

export interface NotificationPrefs {
  push: boolean;
  email: boolean;
  whatsapp: boolean;
  dayBefore: boolean;
  sameDay: boolean;
  /** Nudge to mark a payout received, 3 days after it was due. */
  confirmNudge: boolean;
  /** Heads-up 30 days before a bond matures. */
  maturityHeadsUp: boolean;
}

export const DEFAULT_PREFS: NotificationPrefs = {
  push: true,
  email: true,
  whatsapp: false,
  dayBefore: true,
  sameDay: true,
  confirmNudge: true,
  maturityHeadsUp: true,
};

/**
 * Terms a user types for a bond we do not have yet ("Add manually" / "Add details").
 * Used until Deridata data arrives for the ISIN; verified data then replaces it.
 */
export interface CustomTerms {
  couponRate: number;
  maturityDate: ISODate;
  /** Needed to place payout dates. */
  frequency: 1 | 2 | 4 | 12;
  /** Face value per unit; principal = units x face value. */
  faceValue: number;
  name?: string;
}
