import type { BondTerms } from '@eh/core';

/** A source of bond terms (coupon, frequency, maturity, rating, cash flows) by ISIN. */
export interface BondDataProvider {
  readonly name: string;
  getMany(isins: string[]): Promise<Map<string, BondTerms>>;
  /** Search by ISIN prefix, issuer or bond name. Used by "Type holdings" and screenshot name matching. */
  search(q: string, limit: number): Promise<BondTerms[]>;
}

/** Horizon ISIN list: tells us whether an ISIN exists and what kind of instrument it is. */
export interface IsinDirectory {
  lookup(isins: string[]): Promise<Map<string, IsinInfo>>;
}

export interface IsinInfo {
  isin: string;
  name?: string;
  issuer?: string;
  /** Normalised: 'debt' | 'equity' | 'mutual_fund' | 'other' */
  instrumentType: 'debt' | 'equity' | 'mutual_fund' | 'other';
  active?: boolean;
}

/** BondScanner's own holdings for a user (the "Bought on BondScanner" portfolio). */
export interface InternalHoldingsProvider {
  forUser(userId: string): Promise<{ isin: string; units: number; investedAmount?: number; acquiredOn?: string }[]>;
}

/** The user's own KYC details. Used only to tell whether a statement is theirs. */
export interface UserProfileProvider {
  kycPan(userId: string): Promise<string | undefined>;
}
