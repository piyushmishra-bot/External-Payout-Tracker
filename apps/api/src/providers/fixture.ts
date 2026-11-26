import { FIXTURE_BONDS, FIXTURE_BONDSCANNER_HOLDINGS, type BondTerms } from '@eh/core';
import type { BondDataProvider, InternalHoldingsProvider, IsinDirectory, IsinInfo, UserProfileProvider } from './types';
import { classifyIndianIsin } from '@eh/core';

/** Dev/test provider backed by the fictional fixture bonds. */
export class FixtureBondProvider implements BondDataProvider {
  readonly name = 'fixture';
  constructor(private readonly bonds: BondTerms[] = FIXTURE_BONDS) {}
  async getMany(isins: string[]) {
    const m = new Map<string, BondTerms>();
    for (const b of this.bonds) if (isins.includes(b.isin)) m.set(b.isin, b);
    return m;
  }
  async search(q: string, limit: number) {
    const s = q.trim().toLowerCase();
    if (s.length < 2) return [];
    return this.bonds
      .filter((b) => b.isin.toLowerCase().includes(s) || b.name.toLowerCase().includes(s) || b.issuer.toLowerCase().includes(s))
      .slice(0, limit);
  }
}

/** Classifies by ISIN structure only. Replace with HorizonIsinDirectory when access is granted. */
export class StructuralIsinDirectory implements IsinDirectory {
  async lookup(isins: string[]) {
    const m = new Map<string, IsinInfo>();
    for (const isin of isins) {
      const c = classifyIndianIsin(isin);
      m.set(isin, {
        isin,
        instrumentType: c === 'equity' ? 'equity' : c === 'mutual_fund' ? 'mutual_fund' : c === 'unknown' ? 'other' : 'debt',
      });
    }
    return m;
  }
}

export class FixtureInternalHoldings implements InternalHoldingsProvider {
  async forUser(userId: string) {
    return userId.startsWith('demo') || userId.startsWith('test') ? FIXTURE_BONDSCANNER_HOLDINGS : [];
  }
}

/** Dev/test KYC: demo and test users have PAN ABCDE1234F. */
export class FixtureUserProfile implements UserProfileProvider {
  async kycPan(userId: string) {
    if (process.env.NODE_ENV === 'production') return undefined; // never a made-up PAN in production
    return userId.startsWith('demo') || userId.startsWith('test') ? 'ABCDE1234F' : undefined;
  }
}
