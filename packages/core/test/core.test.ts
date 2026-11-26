import { describe, expect, it } from 'vitest';
import {
  findIdentity,
  TEMPLATE_COLUMNS,
  templateFromGrid,
  templateCsv,
  parseTemplateDate,
  panOwnership,
  maskPan,
  combineOwnership,
  customToTerms,
  findStatementDate,
  validateCustomTerms,
  addMonths,
  classifyIndianIsin,
  DEFAULT_PREFS,
  diffRows,
  findIsins,
  findMatch,
  FIXTURE_BONDS,
  FIXTURE_EQUITY_ISIN,
  financialYear,
  HolidayCalendar,
  holdingEvents,
  inr,
  isValidIsin,
  payoutStatus,
  planReminders,
  portfolioReport,
  ratingBucket,
  summarise,
  taxStatement,
  unitCashflows,
  xirr,
  withAutoReceived,
  yearFractionActAct,
  type BondTerms,
  type HoldingWithTerms,
} from '../src';

const bond = (isin: string) => FIXTURE_BONDS.find((b) => b.isin === isin)!;
const pf = { id: 'p1', name: 'My demat account', source: 'external' as const };
const hw = (isin: string, units: number, extra: Partial<HoldingWithTerms['holding']> = {}): HoldingWithTerms => ({
  holding: { id: `h-${isin}`, portfolioId: 'p1', isin, units, trackedFrom: '2026-11-09', ...extra },
  portfolio: pf,
  terms: bond(isin),
});

describe('ISIN', () => {
  it('validates check digits on real ISINs', () => {
    expect(isValidIsin('US0378331005')).toBe(true);
    expect(isValidIsin('INE002A01018')).toBe(true);
    expect(isValidIsin('INE002A01019')).toBe(false);
    expect(isValidIsin('INE002A0101')).toBe(false);
  });
  it('classifies Indian ISINs and skips equity and funds', () => {
    expect(classifyIndianIsin('INE0AST07019')).toBe('corporate_debt');
    expect(classifyIndianIsin(FIXTURE_EQUITY_ISIN)).toBe('equity');
    expect(classifyIndianIsin('INF209K01YN0')).toBe('mutual_fund');
    expect(classifyIndianIsin('IN0020230085')).toBe('government');
  });
  it('finds only valid ISINs in text', () => {
    expect(findIsins('x INE0AST07019 y INE0AST07018 z ine0bhf07027')).toEqual(['INE0AST07019', 'INE0BHF07027']);
  });
});

describe('dates', () => {
  it('adds months with end-of-month anchoring', () => {
    expect(addMonths('2027-01-31', 1)).toBe('2027-02-28');
    expect(addMonths('2027-02-28', 1, 31)).toBe('2027-03-31');
    expect(addMonths('2028-08-05', -3)).toBe('2028-05-05');
  });
  it('ACT/ACT year fraction handles leap years', () => {
    expect(yearFractionActAct('2027-01-01', '2028-01-01')).toBeCloseTo(1, 10);
    expect(yearFractionActAct('2028-01-01', '2029-01-01')).toBeCloseTo(1, 10);
    expect(yearFractionActAct('2027-12-31', '2028-01-02')).toBeCloseTo(1 / 365 + 1 / 366, 10);
  });
  it('financial year label', () => {
    expect(financialYear('2026-11-17')).toBe('2026-27');
    expect(financialYear('2027-03-31')).toBe('2026-27');
    expect(financialYear('2027-04-01')).toBe('2027-28');
  });
});

describe('cash flow schedule', () => {
  it('monthly coupon moves forward off weekends, amount unchanged (ACT/ACT)', () => {
    const flows = unitCashflows(bond('INE0AST07019'));
    const dec = flows.find((f) => f.scheduledDate === '2026-12-05')!;
    expect(dec.date).toBe('2026-12-07'); // 5 Dec 2026 is a Saturday
    expect(dec.interest).toBeCloseTo((10000 * 0.1125 * 30) / 365, 2);
    expect(dec.recordDate).toBe('2026-11-22');
  });
  it('redemption on a weekend moves back, with interest accrued to that day', () => {
    const flows = unitCashflows(bond('INE0MIT07031'));
    const last = flows[flows.length - 1];
    expect(last.scheduledDate).toBe('2027-11-28'); // Sunday
    expect(last.date).toBe('2027-11-26');
    expect(last.principal).toBe(10000);
    expect(last.interest).toBeCloseTo((10000 * 0.086 * 363) / 365, 2);
  });
  it('respects declared holidays', () => {
    const cal = new HolidayCalendar(['2026-12-07']);
    const dec = unitCashflows(bond('INE0AST07019'), cal).find((f) => f.scheduledDate === '2026-12-05')!;
    expect(dec.date).toBe('2026-12-08');
  });
  it('zero coupon pays once at maturity', () => {
    const flows = unitCashflows(bond('INE0HLC07015'));
    expect(flows).toHaveLength(1);
    expect(flows[0]).toMatchObject({ principal: 10000, interest: 3218, date: '2028-06-30' });
  });
  it('amortising bond halves interest after a part redemption', () => {
    const flows = unitCashflows(bond('INE0ORM07058'));
    const part = flows.find((f) => f.scheduledDate === '2027-12-15')!;
    expect(part.principal).toBe(50000);
    const after = flows.find((f) => f.scheduledDate === '2028-01-15')!;
    // Period straddles the year end: 17 days weighted /365, 14 days /366.
    expect(after.interest).toBeCloseTo(50000 * 0.115 * (17 / 365 + 14 / 366), 2);
    expect(flows[flows.length - 1].principal).toBe(50000);
    expect(flows.reduce((s, f) => s + f.principal, 0)).toBe(100000);
  });
  it('EQUAL day count gives flat coupons', () => {
    const t: BondTerms = { ...bond('INE0BHF07027'), dayCount: 'EQUAL' };
    const flows = unitCashflows(t);
    expect(new Set(flows.map((f) => f.interest)).size).toBe(1);
    expect(flows[0].interest).toBe(260);
  });
  it('vendor cash flows override the generated schedule', () => {
    const t: BondTerms = { ...bond('INE0BHF07027'), cashflows: [{ date: '2027-01-04', interest: 123.45, principal: 0 }] };
    expect(unitCashflows(t)).toEqual([{ date: '2027-01-04', scheduledDate: '2027-01-04', recordDate: '2026-12-20', interest: 123.45, principal: 0 }]);
  });
});

describe('holding events', () => {
  it('scales by units and starts from the tracking date', () => {
    const ev = holdingEvents(hw('INE0AST07019', 5));
    expect(ev[0].scheduledDate).toBe('2026-12-05');
    expect(ev[0].interest).toBeCloseTo(5 * 92.47, 1);
    expect(ev.at(-1)!.isFinal).toBe(true);
    expect(ev.at(-1)!.principal).toBe(50000);
  });
  it('drops payouts whose record date is before the purchase date', () => {
    const ev = holdingEvents(hw('INE0AST07019', 5, { acquiredOn: '2026-11-25' }));
    expect(ev[0].scheduledDate).toBe('2027-01-05'); // Dec record date was 22 Nov
  });
  it('status logic', () => {
    const e = holdingEvents(hw('INE0AST07019', 1))[0]; // pays 7 Dec 2026
    const none = new Set<string>();
    expect(payoutStatus(e, '2026-12-06', none)).toBe('upcoming');
    expect(payoutStatus(e, '2026-12-07', none)).toBe('due_today');
    expect(payoutStatus(e, '2026-12-08', none)).toBe('awaiting_credit');
    expect(payoutStatus(e, '2026-12-09', none)).toBe('not_marked');
    expect(payoutStatus(e, '2026-12-09', new Set([e.key]))).toBe('received');
  });
});

describe('summary and report', () => {
  const items = [hw('INE0AST07019', 5), hw('INE0BHF07027', 10), hw('INE0KPC08018', 1), hw('INE0PNL07049', 4)];
  it('totals principal, interest, avg coupon', () => {
    const s = summarise(items, '2026-11-17');
    expect(s.principal).toBe(50000 + 100000 + 100000 + 40000);
    expect(s.invested).toBe(s.principal);
    expect(s.expectedPrincipal).toBe(s.principal);
    expect(s.expectedInterest).toBeGreaterThan(0);
    expect(s.avgCoupon).toBeCloseTo((50000 * 11.25 + 100000 * 10.4 + 100000 * 7.85 + 40000 * 9.8) / 290000, 2);
    expect(s.xirr).toBeNull();
    expect(s.nextPayout!.date >= '2026-11-17').toBe(true);
  });
  it('computes XIRR when purchase info is present', () => {
    expect(xirr([{ date: '2026-01-01', amount: -100 }, { date: '2027-01-01', amount: 110 }])).toBeCloseTo(10, 1);
    const s = summarise([hw('INE0AST07019', 5, { acquiredOn: '2026-11-09', investedAmount: 50000 })], '2026-11-17');
    expect(s.xirr!).toBeGreaterThan(11);
    expect(s.xirr!).toBeLessThan(12.5);
  });
  it('rating buckets and concentration flags', () => {
    expect(ratingBucket('CRISIL AA-')).toBe('AA');
    expect(ratingBucket('IND A+(CE)')).toBe('A');
    expect(ratingBucket('BBB+')).toBe('BBB');
    expect(ratingBucket(undefined)).toBe('Unrated');
    const r = portfolioReport(items);
    expect(r.ratingMix.reduce((s, x) => s + x.share, 0)).toBeCloseTo(1);
    expect(r.flags.some((f) => f.includes('%'))).toBe(true);
  });
  it('tax statement covers the financial year only', () => {
    const t = taxStatement(items, '2026-27');
    expect(t.rows.every((r) => r.date >= '2026-11-09' && r.date <= '2027-03-31')).toBe(true);
    expect(t.totalTds).toBeCloseTo(t.totalInterest * 0.1, 0);
  });
});

describe('duplicate detection', () => {
  const saved = [{ id: 'p1', name: 'My demat account', rows: [{ isin: 'A', units: 5 }, { isin: 'B', units: 10 }, { isin: 'C', units: 8 }] }];
  it('same', () => {
    expect(findMatch([{ isin: 'C', units: 8 }, { isin: 'A', units: 5 }, { isin: 'B', units: 10 }], saved)?.type).toBe('same');
  });
  it('update', () => {
    const m = findMatch([{ isin: 'A', units: 5 }, { isin: 'B', units: 6 }, { isin: 'D', units: 4 }], saved);
    expect(m?.type).toBe('update');
    expect(diffRows(saved[0].rows, [{ isin: 'A', units: 5 }, { isin: 'B', units: 6 }, { isin: 'D', units: 4 }])).toEqual({
      added: ['D'], removed: ['C'], changed: [{ isin: 'B', from: 10, to: 6 }], unchanged: ['A'],
    });
  });
  it('no match below threshold', () => {
    expect(findMatch([{ isin: 'A', units: 5 }, { isin: 'X', units: 1 }, { isin: 'Y', units: 1 }], saved)).toBeNull();
  });
});

describe('reminders', () => {
  const ev = [...holdingEvents(hw('INE0AST07019', 5)), ...holdingEvents(hw('INE0PNL07049', 4))];
  it('groups payouts on the same day and is idempotent per channel', () => {
    // Pinnacle pays 18 Dec 2026 (Fri); Aster 7 Dec.
    const plan = planReminders({ userId: 'u1', events: ev, prefs: DEFAULT_PREFS, today: '2026-12-06', received: new Set() });
    expect(plan.map((p) => p.kind)).toEqual(['payout_tomorrow', 'payout_tomorrow']);
    expect(plan.map((p) => p.channel)).toEqual(['push', 'email']);
    expect(plan[0].idempotencyKey).toBe('u1:payout_tomorrow:2026-12-07:push');
    expect(plan[0].title).toContain('payout tomorrow');
    expect(plan[0].sendAfter).toBe('2026-12-06T03:30:00.000Z');
  });
  it('skips received payouts and honours prefs', () => {
    const k = ev.find((e) => e.date === '2026-12-07')!.key;
    expect(planReminders({ userId: 'u1', events: ev, prefs: DEFAULT_PREFS, today: '2026-12-06', received: new Set([k]) })).toEqual([]);
    expect(planReminders({ userId: 'u1', events: ev, prefs: { ...DEFAULT_PREFS, push: false, email: false }, today: '2026-12-06', received: new Set() })).toEqual([]);
  });
  it('nudges to confirm 3 days after and warns 30 days before maturity', () => {
    const nudge = planReminders({ userId: 'u1', events: ev, prefs: { ...DEFAULT_PREFS, email: false }, today: '2026-12-10', received: new Set() });
    expect(nudge.map((n) => n.kind)).toEqual(['confirm_received']);
    const last = ev.filter((e) => e.isFinal)[0];
    const d = new Date(Date.parse(last.date) - 30 * 864e5).toISOString().slice(0, 10);
    const m = planReminders({ userId: 'u1', events: ev, prefs: { ...DEFAULT_PREFS, email: false }, today: d, received: new Set() });
    expect(m.some((n) => n.kind === 'maturity_30d')).toBe(true);
  });
});

describe('format', () => {
  it('uses Indian grouping', () => {
    expect(inr(1240500)).toBe('₹12,40,500');
    expect(inr(92.47)).toBe('₹92.47');
  });
});

describe('auto-received for BondScanner holdings', () => {
  it('marks past BondScanner payouts received but leaves external ones alone', () => {
    const bs: HoldingWithTerms = { ...hw('INE0CVC07023', 6, { trackedFrom: '2026-05-04' }), portfolio: { id: 'bondscanner', name: 'Bought on BondScanner', source: 'bondscanner' } };
    const ext = hw('INE0AST07019', 5, { trackedFrom: '2026-06-01' });
    const r = withAutoReceived([bs, ext], '2026-11-17', new Set());
    const keys = [...r];
    expect(keys.length).toBeGreaterThan(3);
    expect(keys.every((k) => k.startsWith('h-INE0CVC07023'))).toBe(true);
    expect(summarise([bs, ext], '2026-11-17', r).unconfirmedCount).toBeGreaterThan(0); // external still need marking
    expect(summarise([bs], '2026-11-17', withAutoReceived([bs], '2026-11-17', new Set())).unconfirmedCount).toBe(0);
  });
});

describe('user-entered terms and statement dates', () => {
  it('builds a payout schedule from the four manual fields + frequency and face value', () => {
    const t = customToTerms('INE420C07239', { couponRate: 9.25, faceValue: 10000, frequency: 4, maturityDate: '2029-03-15', name: 'Shriram Finance' }, '2026-11-17');
    const ev = holdingEvents({ holding: { id: 'x', portfolioId: 'p', isin: t.isin, units: 10, trackedFrom: '2026-11-17' }, portfolio: pf, terms: t });
    expect(ev[0]).toMatchObject({ scheduledDate: '2026-12-15', interest: 2312.5, estimated: true });
    expect(ev.at(-1)!.principal).toBe(100000);
    expect(t.name).toBe('Shriram Finance Mar ’29');
  });
  it('validates without upper limits', () => {
    expect(validateCustomTerms({ couponRate: 55, faceValue: 1000, frequency: 12, maturityDate: '2030-01-01' }, '2026-11-17')).toBeNull();
    expect(validateCustomTerms({ couponRate: 9, faceValue: 1000, frequency: 12, maturityDate: '2026-02-30' }, '2026-11-17')).toBe('That date does not exist');
    expect(validateCustomTerms({ couponRate: 9, faceValue: 1000, frequency: 12, maturityDate: '2025-01-01' }, '2026-11-17')).toBe('Maturity date must be in the future');
    expect(validateCustomTerms({ couponRate: 9, frequency: 12, maturityDate: '2030-01-01' }, '2026-11-17')).toBe('Enter the face value per unit');
  });
  it('finds statement dates in common formats', () => {
    expect(findStatementDate('Holdings as on 30-Nov-2026 for PAN')).toBe('2026-11-30');
    expect(findStatementDate('Statement Date: 05/10/2026')).toBe('2026-10-05');
    expect(findStatementDate('for the period 01-Sep-2026 to 30-Sep-2026')).toBe('2026-09-30');
    expect(findStatementDate('As of 7 January 2026')).toBe('2026-01-07');
    expect(findStatementDate('no date here')).toBeNull();
  });
  it('vendor terms with an issue date are not estimated', () => {
    expect(holdingEvents(hw('INE0AST07019', 1))[0].estimated).toBe(false);
  });
});

describe('statement ownership', () => {
  it('reads PAN and holder from statement text', () => {
    expect(findIdentity('Consolidated Account Statement  Name: RAMESH KUMAR  PAN: PQRSX5678K  as on 30-Nov-2026')).toEqual({ pan: 'PQRSX5678K', holder: 'RAMESH KUMAR' });
    expect(findIdentity('PAN : XXXXX1234F').pan).toBe('XXXXX1234F');
    expect(findIdentity('PAN No. ****1234F').pan).toBeUndefined(); // too short after mask
    expect(findIdentity('no identity here INE0AST07019').pan).toBeUndefined();
  });
  it('matches full and masked PANs against KYC', () => {
    expect(panOwnership('ABCDE1234F', 'ABCDE1234F')).toBe('self');
    expect(panOwnership('PQRSX5678K', 'ABCDE1234F')).toBe('other');
    expect(panOwnership('XXXXX1234F', 'ABCDE1234F')).toBe('self');
    expect(panOwnership('XXXXX5678K', 'ABCDE1234F')).toBe('other');
    expect(panOwnership('XXXXXXXXXF', 'ABCDE1234F')).toBe('unknown');
    expect(panOwnership(undefined, 'ABCDE1234F')).toBe('unknown');
    expect(panOwnership('AXCDE1234F', 'AXCDE1234F')).toBe('self'); // real X in a full PAN
  });
  it('masks and combines', () => {
    expect(maskPan('PQRSX5678K')).toBe('XXXXX5678K');
    expect(combineOwnership(['self', 'unknown'])).toBe('unknown');
    expect(combineOwnership(['self', 'other'])).toBe('other');
    expect(combineOwnership(['self', 'self'])).toBe('self');
  });
});

describe('holdings template (ISIN, Units, Investment amount, Date of investment, Yield)', () => {
  const T = '2026-11-19';
  const head: string[] = TEMPLATE_COLUMNS.map((c) => c.header);
  const example: string[] = TEMPLATE_COLUMNS.map((c) => c.example);
  const good = ['INE134E07ED4', 'Power Finance Corporation', '2', '₹20,100', '01/11/2026', '5.4%'];

  it('has exactly the six required columns and ships empty (header row only)', () => {
    expect(head).toEqual(['ISIN', 'Issuer name', 'Units', 'Investment amount (₹)', 'Date of investment', 'Yield (% p.a.)']);
    expect(templateCsv()).toBe(head.join(',') + '\r\n');
    expect(templateFromGrid([head], T).problems[0].message).toContain('no bonds');
  });

  it('reads a row; extra columns are ignored', () => {
    const { rows, problems } = templateFromGrid([[...head, 'Notes'], [...good, 'my broker']], T);
    expect(problems).toEqual([]);
    expect(rows).toEqual([{ row: 2, isin: 'INE134E07ED4', issuerName: 'Power Finance Corporation', units: 2, investedAmount: 20100, acquiredOn: '2026-11-01', purchaseYield: 5.4 }]);
  });

  it('keeps a row even when it matches the instructions example exactly (it is the user’s own data)', () => {
    expect(templateFromGrid([head, example], T).rows[0]).toMatchObject({ isin: example[0], issuerName: example[1], units: Number(example[2]), purchaseYield: Number(example[5]) });
  });

  it('lists every bad row with the reason and keeps the good ones', () => {
    const r = (patch: Record<number, string>) => good.map((v, i) => patch[i] ?? v);
    const o = 'INE0LN107105';
    const { rows, problems } = templateFromGrid(
      [head, good, r({ 0: 'INE134E07ED5' }), r({ 0: o, 2: '2.5' }), r({ 0: o, 3: '0' }), r({ 0: o, 4: '' }), r({ 0: o, 4: '31/02/2026' }), r({ 0: o, 4: '01/01/2027' }), r({ 0: o, 5: '' }), r({ 0: o, 5: '75' }), r({ 0: o, 1: '' })],
      T,
    );
    expect(rows).toHaveLength(1);
    expect(problems.map((p) => [p.row, p.field])).toEqual([
      [3, 'isin'], [4, 'units'], [5, 'invested'], [6, 'investedOn'], [7, 'investedOn'], [8, 'investedOn'], [9, 'yield'], [10, 'yield'], [11, 'issuer'],
    ]);
  });

  it('keeps the same ISIN on different dates as separate rows and combines only rows with the same date', () => {
    const isin = 'INE733E07KG3';
    const { rows, problems, merged } = templateFromGrid(
      [head, good, [isin, 'REC Limited', '1', '10000', '01/09/2026', '10'], [isin, 'REC Limited', '3', '30000', '15/10/2026', '12'], [isin, 'REC Limited', '2', '20000', '01/09/2026', '11'], [isin, 'REC Limited', '1.5', '1', '01/10/2026', '10']],
      T,
    );
    expect(rows).toEqual([
      { row: 2, isin: 'INE134E07ED4', issuerName: 'Power Finance Corporation', units: 2, investedAmount: 20100, acquiredOn: '2026-11-01', purchaseYield: 5.4 },
      { row: 3, isin, issuerName: 'REC Limited', units: 3, investedAmount: 30000, acquiredOn: '2026-09-01', purchaseYield: 10.67 },
      { row: 4, isin, issuerName: 'REC Limited', units: 3, investedAmount: 30000, acquiredOn: '2026-10-15', purchaseYield: 12 },
    ]);
    expect(merged).toEqual([{ isin, acquiredOn: '2026-09-01', rows: [3, 5] }]);
    // A bad row for the same bond is still reported, not combined.
    expect(problems.map((p) => p.row)).toEqual([6]);
  });

  it('needs the template columns and accepts other header spellings and dates', () => {
    expect(templateFromGrid([['ISIN', 'Qty'], ['INE134E07ED4', '2']], T).problems[0].message).toContain('Missing column');
    expect(templateFromGrid([['ISIN', 'Units', 'Investment amount', 'Date of investment'], ['INE134E07ED4', '2', '20000', '01/11/2026']], T).problems[0].message).toContain('Yield');
    expect(templateFromGrid([['Name'], ['x']], T).problems[0].message).toContain('not in our holdings template');
    expect(templateFromGrid([['isin code', 'Company', 'Quantity', 'Invested Amount', 'Purchase date', 'YTM'], ['INE134E07ED4', 'PFC', 3, 30000, new Date(Date.UTC(2026, 9, 5)), 9.5]], T).rows[0]).toMatchObject({ issuerName: 'PFC', units: 3, investedAmount: 30000, acquiredOn: '2026-10-05', purchaseYield: 9.5 });
    expect(parseTemplateDate('05-Oct-2026')).toBe('2026-10-05');
  });
});

describe('expected yield (XIRR)', () => {
  it('counts payouts between the purchase date and the day the bond was added', () => {
    const terms = { isin: 'INE0GCN07054', name: 'Adani Airports Feb ’29', issuer: 'Adani Airports', faceValue: 100000, couponRate: 8.45, frequency: 4 as const, couponType: 'fixed' as const, dayCount: 'ACT/ACT' as const, issueDate: '2026-02-12', maturityDate: '2029-02-12', verified: true, cashflows: [
      { date: '2026-06-30', interest: 2112.5, principal: 0 }, { date: '2026-09-30', interest: 2112.5, principal: 0 }, { date: '2026-12-31', interest: 2129.86, principal: 0 },
      { date: '2027-03-31', interest: 2083.56, principal: 0 }, { date: '2027-06-30', interest: 2106.71, principal: 0 }, { date: '2027-09-30', interest: 2129.86, principal: 0 },
      { date: '2027-12-31', interest: 2129.86, principal: 0 }, { date: '2028-03-31', interest: 2100.96, principal: 0 }, { date: '2028-06-30', interest: 2106.71, principal: 0 },
      { date: '2028-09-30', interest: 2129.86, principal: 0 }, { date: '2028-12-31', interest: 2129.86, principal: 0 }, { date: '2029-02-12', interest: 995.62, principal: 100000 },
    ] };
    const holding = { id: 'h1', portfolioId: 'p1', isin: terms.isin, units: 1, investedAmount: 100800, acquiredOn: '2026-05-02', trackedFrom: '2026-11-26' };
    const s = summarise([{ holding, terms, portfolio: { id: 'p1', name: 'Holding 1' } } as any], '2026-11-26');
    // Bought near par with an 8.45% coupon: yield should be close to 8%, not dragged down by skipping two coupons.
    expect(s.xirr!).toBeGreaterThan(7.8);
    expect(s.xirr!).toBeLessThan(9);
  });
});
