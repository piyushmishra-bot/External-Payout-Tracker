import type { BondTerms } from './types';

/**
 * Fictional bond master used in development, tests and the demo build.
 * Issuers, ISINs and terms are invented; ISIN check digits are valid.
 * Replace with SNAPE / Deridata data in staging and production.
 */
const base = { source: 'fixture' as const, verified: true, listed: true, recordDateOffsetDays: 15 };

export const FIXTURE_BONDS: BondTerms[] = [
  { ...base, isin: 'INE0AST07019', sector: 'NBFC', issuer: 'Aster Finance Ltd', name: 'Aster Finance Aug ’28', faceValue: 10000, couponRate: 11.25, frequency: 12, couponType: 'fixed', dayCount: 'ACT/ACT', issueDate: '2025-08-05', maturityDate: '2028-08-05', rating: 'AA-', ratingAgency: 'CRISIL', securityType: 'ncd' },
  { ...base, isin: 'INE0BHF07027', sector: 'Housing finance', issuer: 'Brightline Housing Finance', name: 'Brightline Housing Mar ’29', faceValue: 10000, couponRate: 10.4, frequency: 4, couponType: 'fixed', dayCount: 'ACT/ACT', issueDate: '2026-03-20', maturityDate: '2029-03-20', rating: 'A+', ratingAgency: 'ICRA', securityType: 'ncd' },
  { ...base, isin: 'INE0KPC08018', sector: 'Power', issuer: 'Kaveri Power Corporation', name: 'Kaveri Power May ’31', faceValue: 100000, couponRate: 7.85, frequency: 2, couponType: 'fixed', dayCount: 'ACT/ACT', issueDate: '2024-05-18', maturityDate: '2031-05-18', rating: 'AAA', ratingAgency: 'CRISIL', securityType: 'bond' },
  { ...base, isin: 'INE0MIT07031', sector: 'Infrastructure', issuer: 'Meridian Infra Trust', name: 'Meridian Infra Nov ’27', faceValue: 10000, couponRate: 8.6, frequency: 1, couponType: 'fixed', dayCount: 'ACT/ACT', issueDate: '2024-11-28', maturityDate: '2027-11-28', rating: 'AAA', ratingAgency: 'CARE', securityType: 'ncd' },
  { ...base, isin: 'INE0NMB07013', sector: 'NBFC', issuer: 'Nimbus Credit Ltd', name: 'Nimbus Credit Sep ’29', faceValue: 10000, couponRate: 10.9, frequency: 4, couponType: 'fixed', dayCount: 'ACT/ACT', issueDate: '2026-09-26', maturityDate: '2029-09-26', rating: 'A', ratingAgency: 'IND', securityType: 'ncd' },
  { ...base, isin: 'INE0PNL07049', sector: 'NBFC', issuer: 'Pinnacle Leasing Ltd', name: 'Pinnacle Leasing Apr ’28', faceValue: 10000, couponRate: 9.8, frequency: 12, couponType: 'fixed', dayCount: 'ACT/ACT', issueDate: '2025-04-18', maturityDate: '2028-04-18', rating: 'BBB+', ratingAgency: 'ACUITE', securityType: 'ncd' },
  { ...base, isin: 'INE0ZRL08013', sector: 'Infrastructure', issuer: 'Zenith Roads Ltd', name: 'Zenith Roads Feb ’30', faceValue: 10000, couponRate: 7.6, frequency: 4, couponType: 'fixed', dayCount: 'ACT/ACT', issueDate: '2025-02-14', maturityDate: '2030-02-14', rating: 'AAA', ratingAgency: 'CRISIL', securityType: 'bond' },
  { ...base, isin: 'INE0CVC07023', sector: 'NBFC', issuer: 'Corvus Capital Ltd', name: 'Corvus Capital Oct ’27', faceValue: 10000, couponRate: 9.2, frequency: 12, couponType: 'fixed', dayCount: 'ACT/ACT', issueDate: '2025-10-12', maturityDate: '2027-10-12', rating: 'AA', ratingAgency: 'ICRA', securityType: 'ncd' },
  { ...base, isin: 'INE0HLC07015', sector: 'NBFC', issuer: 'Halcyon Capital Ltd', name: 'Halcyon Capital Jun ’28 (zero coupon)', faceValue: 10000, couponRate: 9.75, frequency: 0, couponType: 'zero', dayCount: 'ACT/ACT', issueDate: '2025-06-30', maturityDate: '2028-06-30', maturityAmount: 13218, rating: 'AA', ratingAgency: 'CARE', securityType: 'ncd' },
  { ...base, isin: 'INE0ORM07058', sector: 'MFI', issuer: 'Orchid Microfin Ltd', name: 'Orchid Microfin Dec ’28', faceValue: 100000, couponRate: 11.5, frequency: 12, couponType: 'fixed', dayCount: 'ACT/ACT', issueDate: '2025-12-15', maturityDate: '2028-12-15', rating: 'A-', ratingAgency: 'CRISIL', securityType: 'ncd', redemptions: [{ date: '2027-12-15', principal: 50000 }] },
];

/** An equity ISIN that imports must skip. */
export const FIXTURE_EQUITY_ISIN = 'INE0QXZ01015';

/** ISINs BondScanner itself sold to the demo user (the "Bought on BondScanner" portfolio). */
export const FIXTURE_BONDSCANNER_HOLDINGS = [
  { isin: 'INE0ZRL08013', units: 10, acquiredOn: '2026-02-20', investedAmount: 101250 },
  { isin: 'INE0CVC07023', units: 6, acquiredOn: '2026-05-04', investedAmount: 60480 },
];
