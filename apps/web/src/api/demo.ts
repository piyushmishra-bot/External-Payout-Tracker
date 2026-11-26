/**
 * In-browser implementation of the API for the stakeholder demo build. Mirrors the
 * server's rules (same @eh/core engine and CSV parser) with fictional fixture bonds.
 * Nothing leaves the browser.
 */
import {
  allEvents,
  classifyIndianIsin,
  customToTerms,
  diffRows,
  findMatch,
  formatDateNumeric,
  FIXTURE_BONDS,
  HolidayCalendar,
  isValidIsin,
  normaliseIsin,
  overlaps,
  payoutStatus,
  portfolioReport,
  summarise,
  validateCustomTerms,
  combineOwnership,
  maskPan,
  panOwnership,
  type Ownership,
  type BondTerms,
  type CustomTerms,
  type HoldingWithTerms,
} from '@eh/core';
import { parseCsvText } from '../../../api/src/parsers/grid';
import { ApiError, BLOCKING, type Api, type CommitBody, type DraftRow, type FileResult, type ImportDraft, type ReviewRow } from './types';

const CAL = new HolidayCalendar(['2026-11-24', '2026-12-25', '2027-01-26', '2027-03-03']);
const BOND = new Map<string, BondTerms>(FIXTURE_BONDS.map((b) => [b.isin, b]));
const uid = () => Math.random().toString(36).slice(2, 10);

type SampleRow = { isin?: string; units?: number; nameHint?: string; customTerms?: CustomTerms; acquiredOn?: string; investedAmount?: number; purchaseYield?: number };
/** Demo user's KYC PAN. */
const USER_PAN = 'ABCDE1234F';

interface Sample {
  label: string;
  rows: SampleRow[];
  pan?: string;
  holder?: string;
  statementDate?: string;
  password?: string;
  fail?: 'unreadable';
}

/** Demo "files" that stand in for the phone's file picker (shown in the demo bar, never on the phone). */
export const DEMO_FILES: Record<string, Sample> = {
  'CAS_Nov2026.pdf': {
    label: 'Locked CAS PDF (password: demo)',
    password: 'demo',
    pan: 'XXXXX1234F',
    holder: 'RAHUL KUMAR',
    statementDate: '2026-11-15',
    rows: [
      { isin: 'INE0AST07019', units: 5, nameHint: 'ASTER FINANCE LTD 11.25% NCD' },
      { isin: 'INE0BHF07027', units: 10, nameHint: 'BRIGHTLINE HOUSING FIN NCD' },
      { isin: 'INE0KPC08018', units: 1, nameHint: 'KAVERI POWER CORP 7.85% BOND' },
      { isin: 'INE0MIT07031', units: 8, nameHint: 'MERIDIAN INFRA TRUST NCD' },
      { isin: 'INE0QXZ01015', units: 100, nameHint: 'SOME EQUITY LTD' },
    ],
  },
  'Wint_Holdings.xlsx': {
    label: 'Excel sheet',
    statementDate: '2026-11-10',
    rows: [
      { isin: 'INE0NMB07013', units: 5, nameHint: 'Nimbus Credit' },
      { isin: 'INE0PNL07049', units: 40000, nameHint: 'Pinnacle Leasing' },
      { isin: 'INE0HLC07015', units: 3, nameHint: 'Halcyon Capital ZCB' },
    ],
  },
  'App_Screenshot.png': {
    label: 'Screenshot with problems',
    rows: [
      { isin: 'INE0PNL07049', units: 4, nameHint: 'Pinnacle Leasing' },
      { isin: 'INE0ORM07058', units: undefined, nameHint: 'Orchid Microfin' },
      { isin: 'INE0NMB0701', units: 3, nameHint: 'Nimbus Credit 10.90%' },
      { isin: 'INE0XYZ07016', units: 2, nameHint: 'Xylo Finance NCD' },
    ],
  },
  'CAS_Dec2026.pdf': {
    label: 'Newer statement (Dec)',
    pan: 'XXXXX1234F',
    statementDate: '2026-12-01',
    rows: [
      { isin: 'INE0AST07019', units: 5 },
      { isin: 'INE0BHF07027', units: 6 },
      { isin: 'INE0MIT07031', units: 8 },
      { isin: 'INE0NMB07013', units: 5 },
    ],
  },
  'CAS_Sep2026.pdf': {
    label: 'Older statement (Sep)',
    pan: 'XXXXX1234F',
    statementDate: '2026-09-30',
    rows: [
      { isin: 'INE0AST07019', units: 5 },
      { isin: 'INE0BHF07027', units: 10 },
      { isin: 'INE0KPC08018', units: 1 },
      { isin: 'INE0MIT07031', units: 8 },
    ],
  },
  'Shares_only.pdf': { label: 'Shares only', rows: [{ isin: 'INE0QXZ01015', units: 50, nameHint: 'SOME EQUITY LTD' }] },
  'Blurry_scan.pdf': { label: 'Unreadable file', rows: [], fail: 'unreadable' },
};

const FILE_MESSAGE: Record<string, string> = {
  empty: 'No holdings found in this file.',
  only_non_bonds: 'Only shares or mutual funds found. External Holdings tracks bonds.',
  password_required: 'This PDF is locked. Enter its password and try again.',
  password_incorrect: 'That password did not work. CAS passwords are usually your PAN in capitals.',
  unreadable: 'We could not read this file. Retry, or upload a clearer copy.',
  unsupported: 'Upload a PDF, Excel (.xlsx), CSV or a screenshot (PNG, JPG).',
  duplicate_file: 'You already added this exact file before, so it was skipped.',
};

interface DemoHolding {
  id: string;
  portfolioId: string;
  isin: string;
  units: number;
  trackedFrom: string;
  customTerms?: CustomTerms;
  awaiting?: boolean;
  detailsRequested?: boolean;
  acquiredOn?: string;
  investedAmount?: number;
  purchaseYield?: number;
}

export class DemoApi implements Api {
  today = '2026-11-17';
  private consented = false;
  private portfolios: { id: string; name: string; createdAt: string; statementDate: string | null; ownerType: 'self' | 'family'; ownerLabel: string | null; ownerPan: string | null }[] = [];
  private holdings: DemoHolding[] = [];
  private received = new Set<string>();
  private imports = new Map<string, { rows: DraftRow[]; committed: boolean; files: FileResult[]; skipped: ImportDraft['skipped']; statementDate: string | null; createdAt: string; names: string[]; manual?: boolean }>();
  private seenFiles = new Set<string>();
  private listeners = new Set<() => void>();

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  private emit() {
    this.listeners.forEach((f) => f());
  }
  setToday(d: string) {
    this.today = d;
    this.emit();
  }
  reset() {
    this.consented = false;
    this.portfolios = [];
    this.holdings = [];
    this.received.clear();
    this.imports.clear();
    this.seenFiles.clear();
    this.emit();
  }
  seed() {
    this.reset();
    this.consented = true;
    const id = uid();
    this.portfolios.push({ id, name: 'My holdings', createdAt: '2026-11-09', statementDate: '2026-11-15', ownerType: 'self', ownerLabel: null, ownerPan: 'XXXXX1234F' });
    // Sample investment entries (date, amount, yield) as if added manually.
    const inv: Record<string, [string, number, number]> = {
      INE0AST07019: ['2025-09-12', 50412.5, 11.1],
      INE0BHF07027: ['2026-03-20', 100000, 10.4],
      INE0KPC08018: ['2024-06-03', 98750, 8.15],
      INE0MIT07031: ['2025-01-15', 80960, 8.2],
    };
    for (const r of DEMO_FILES['CAS_Nov2026.pdf'].rows.filter((r) => r.isin !== 'INE0QXZ01015')) {
      const v = inv[r.isin!];
      this.holdings.push({ id: uid(), portfolioId: id, isin: r.isin!, units: r.units!, trackedFrom: '2026-11-09', acquiredOn: v?.[0], investedAmount: v?.[1], purchaseYield: v?.[2] });
    }
    this.seenFiles.add('CAS_Nov2026.pdf');
    this.emit();
  }
  /** Lets "Pretend the bond was added" release Notify-me bonds, like the 6-hourly sync. */
  /** Like 4 syncs (≈1 day) with no data: the user gets the "add details" reminder. Returns the first holding id. */
  askForDetails(): string | null {
    let first: string | null = null;
    for (const h of this.holdings)
      if (h.awaiting && !BOND.has(h.isin)) {
        h.detailsRequested = true;
        first ??= h.id;
      }
    this.emit();
    return first;
  }
  async setInvestment(holdingId: string, v: { units: number; acquiredOn: string; investedAmount: number; purchaseYield: number }) {
    if (v.acquiredOn > this.today) throw new ApiError(400, 'invalid_date', 'Date of investment cannot be in the future');
    const h = this.holdings.find((x) => x.id === holdingId);
    if (!h) throw new ApiError(404, 'holding_not_found', 'Holding not found');
    Object.assign(h, { units: v.units, acquiredOn: v.acquiredOn, investedAmount: v.investedAmount, purchaseYield: v.purchaseYield });
    this.emit();
    await this.wait(null, 200);
  }
  async addDetails(holdingId: string, terms: CustomTerms) {
    const e = validateCustomTerms(terms, this.today);
    if (e) throw new ApiError(400, 'invalid_details', e);
    const h = this.holdings.find((x) => x.id === holdingId);
    if (!h) throw new ApiError(404, 'holding_not_found', 'Holding not found');
    h.customTerms = terms;
    h.awaiting = false;
    h.detailsRequested = false;
    this.emit();
    await this.wait(null, 200);
  }

  releaseAwaiting(isin = 'INE0XYZ07016') {
    BOND.set(isin, { ...FIXTURE_BONDS[1], isin, issuer: 'Xylo Finance Ltd', name: 'Xylo Finance Jun ’29', maturityDate: '2029-06-20' });
    for (const h of this.holdings) if (h.isin === isin) h.awaiting = false;
    this.emit();
  }

  private wait<T>(v: T, ms = 220): Promise<T> {
    return new Promise((r) => setTimeout(() => r(v), ms));
  }

  private items(scope = 'all') {
    const items: HoldingWithTerms[] = [];
    const awaiting: { id: string; portfolioId: string; isin: string; units: number; name: string; detailsRequested?: boolean; investedAmount?: number; investedOn?: string; purchaseYield?: number; entered?: boolean }[] = [];
    for (const h of this.holdings) {
      if (scope !== 'all' && scope !== h.portfolioId) continue;
      const p = this.portfolios.find((x) => x.id === h.portfolioId)!;
      const t = BOND.get(h.isin) ?? (h.customTerms ? customToTerms(h.isin, h.customTerms, h.trackedFrom) : undefined);
      if (!t || h.awaiting) {
        awaiting.push({ id: h.id, portfolioId: h.portfolioId, isin: h.isin, units: h.units, name: 'Details awaited', detailsRequested: h.detailsRequested, investedAmount: h.investedAmount, investedOn: h.acquiredOn, purchaseYield: h.purchaseYield, entered: !!(h.investedAmount && h.acquiredOn) });
        continue;
      }
      items.push({ holding: { id: h.id, portfolioId: h.portfolioId, isin: h.isin, units: h.units, trackedFrom: h.trackedFrom, acquiredOn: h.acquiredOn, investedAmount: h.investedAmount, purchaseYield: h.purchaseYield }, portfolio: { id: p.id, name: p.name, source: 'external' }, terms: t });
    }
    return { items, awaiting };
  }

  async status() {
    return this.wait({ consented: this.consented, externalPortfolios: this.portfolios.length }, 40);
  }
  async profile() {
    return { name: 'Demo user', email: 'demo@example.com' };
  }
  async setProfile() {}
  trackEvent() {}
  async sendAssisted() {
    return { id: 'demo' };
  }
  async myAssisted() {
    return [];
  }
  async consent() {
    this.consented = true;
  }
  async overview(scope = 'all') {
    const { items, awaiting } = this.items(scope);
    const all = this.items().items;
    return this.wait({
      today: this.today,
      scope,
      summary: summarise(items, this.today, this.received, CAL),
      portfolios: this.portfolios.map((p) => {
        const mine = all.filter((i) => i.portfolio.id === p.id);
        return { ...p, source: 'external' as const, holdingsCount: mine.length, principal: mine.reduce((s, i) => s + i.holding.units * i.terms.faceValue, 0) };
      }),
      holdings: items.map((i) => ({
        id: i.holding.id, portfolioId: i.portfolio.id, isin: i.terms.isin, name: i.terms.name, issuer: i.terms.issuer, rating: i.terms.rating ?? 'Unrated',
        couponRate: i.terms.couponRate, frequency: i.terms.frequency, maturityDate: i.terms.maturityDate, faceValue: i.terms.faceValue,
        units: i.holding.units, principal: i.holding.units * i.terms.faceValue, verified: i.terms.verified, matured: i.terms.maturityDate < this.today,
        investedAmount: i.holding.investedAmount ?? null, investedOn: i.holding.acquiredOn ?? null, purchaseYield: i.holding.purchaseYield ?? null,
      })),
      awaiting,
      overlaps: overlaps(this.portfolios.map((p) => ({ id: p.id, name: p.name, rows: all.filter((i) => i.portfolio.id === p.id).map((i) => ({ isin: i.terms.isin, units: i.holding.units })) }))),
    });
  }
  async payouts(o: { scope?: string; from?: string; to?: string } = {}) {
    const { items } = this.items(o.scope);
    return this.wait({
      today: this.today,
      payouts: allEvents(items, CAL, { from: o.from, to: o.to }).map((e) => ({ ...e, portfolioName: items.find((i) => i.portfolio.id === e.portfolioId)?.portfolio.name, status: payoutStatus(e, this.today, this.received) })),
    });
  }
  async setReceived(holdingId: string, scheduledDate: string, received: boolean) {
    const k = `${holdingId}|${scheduledDate}`;
    if (received) this.received.add(k);
    else this.received.delete(k);
  }
  async report(scope = 'all') {
    return this.wait(portfolioReport(this.items(scope).items));
  }
  async searchBonds(q: string) {
    const s = q.toLowerCase();
    return this.wait(
      [...BOND.values()].filter((b) => b.isin.toLowerCase().includes(s) || b.name.toLowerCase().includes(s) || b.issuer.toLowerCase().includes(s)).slice(0, 6)
        .map((b) => ({ isin: b.isin, name: b.name, issuer: b.issuer, rating: b.rating, couponRate: b.couponRate, frequency: b.frequency, maturityDate: b.maturityDate })),
      120,
    );
  }

  async uploadFiles(files: { file: File; password?: string }[]): Promise<ImportDraft> {
    const results: FileResult[] = [];
    const parsed: (SampleRow & { confidence: 'high' | 'low'; file: string })[] = [];
    let statementDate: string | null = null;
    const names: string[] = [];
    for (const [index, { file, password }] of files.entries()) {
      const r: FileResult = { index, filename: file.name, status: 'read', bonds: 0 };
      results.push(r);
      const sample = DEMO_FILES[file.name];
      if (this.seenFiles.has(file.name) || names.includes(file.name)) {
        r.status = 'duplicate_file';
        continue;
      }
      if (sample) {
        if (sample.fail) {
          r.status = sample.fail;
          continue;
        }
        if (sample.password && password !== sample.password) {
          r.status = password ? 'password_incorrect' : 'password_required';
          continue;
        }
        names.push(file.name);
        r.owner = panOwnership(sample.pan, USER_PAN);
        if (sample.pan) r.pan = maskPan(sample.pan);
        r.holder = sample.holder;
        if (sample.statementDate && (!statementDate || sample.statementDate > statementDate)) statementDate = sample.statementDate;
        for (const x of sample.rows) parsed.push({ ...x, confidence: /\.(pdf|png|jpe?g)$/i.test(file.name) ? 'low' : 'high', file: file.name });
      } else if (/\.(csv|txt)$/i.test(file.name)) {
        const res = parseCsvText(await file.text());
        names.push(file.name);
        r.owner = panOwnership(res.identity?.pan, USER_PAN);
        if (res.identity?.pan) r.pan = maskPan(res.identity.pan);
        r.holder = res.identity?.holder;
        if (res.statementDate) statementDate = res.statementDate;
        for (const x of res.rows) parsed.push({ isin: x.isin, units: x.units, nameHint: x.nameHint, confidence: x.confidence, file: file.name });
      } else if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
        // Real PDFs are read in the browser with the server's own parser.
        try {
          const { readPdfInBrowser } = await import('./demo-pdf');
          const res = await readPdfInBrowser(file, password);
          names.push(file.name);
          r.owner = panOwnership(res.identity?.pan, USER_PAN);
          if (res.identity?.pan) r.pan = maskPan(res.identity.pan);
          r.holder = res.identity?.holder;
          if (res.statementDate && (!statementDate || res.statementDate > statementDate)) statementDate = res.statementDate;
          for (const x of res.rows) parsed.push({ isin: x.isin, units: x.units, nameHint: x.nameHint, confidence: x.confidence, file: file.name });
        } catch (e) {
          const { isPasswordError } = await import('./demo-pdf');
          const pw = isPasswordError(e);
          r.status = pw === 'incorrect' ? 'password_incorrect' : pw === 'required' ? 'password_required' : 'unreadable';
        }
      } else {
        // No server in the demo: Excel files and screenshots are read by the real app on BondScanner's server.
        r.status = 'unreadable';
        r.message = 'This demo reads PDFs and CSV files. Excel files and screenshots are read by the real app on BondScanner’s server.';
      }
    }
    const { rows, skipped } = this.merge(parsed);
    for (const r of results) {
      if (r.status === 'read') {
        r.bonds = rows.filter((x) => x.files?.includes(r.filename)).length;
        if (!r.bonds) r.status = skipped.some((s) => s.file === r.filename) ? 'only_non_bonds' : 'empty';
      }
      if (r.status !== 'read' && !r.message) r.message = FILE_MESSAGE[r.status];
    }
    const id = uid();
    this.imports.set(id, { rows, committed: false, files: results, skipped, statementDate, createdAt: new Date().toISOString(), names });
    return this.wait({ importId: id, files: results, rows: this.reviewRows(rows), skipped, statementDate }, 500);
  }

  async manual(input: { isin: string; units: number; acquiredOn?: string; investedAmount?: number; purchaseYield?: number; customTerms?: CustomTerms }[]) {
    const { rows, skipped } = this.merge(input.map((r) => ({ ...r, confidence: 'high' as const, file: '' })));
    const id = uid();
    this.imports.set(id, { rows, committed: false, files: [], skipped, statementDate: null, createdAt: new Date().toISOString(), names: [], manual: true });
    return this.wait({ importId: id, files: [], rows: this.reviewRows(rows), skipped, statementDate: null }, 250);
  }

  private merge(parsed: (SampleRow & { confidence: 'high' | 'low'; file: string })[]) {
    const rows: DraftRow[] = [];
    const skipped: ImportDraft['skipped'] = [];
    const by = new Map<string, DraftRow>();
    for (const r of parsed) {
      const isin = r.isin ? normaliseIsin(r.isin) : undefined;
      const c = isin && isValidIsin(isin) ? classifyIndianIsin(isin) : 'unknown';
      if (c === 'equity' || c === 'mutual_fund') {
        skipped.push({ isin: isin!, reason: c, name: r.nameHint, file: r.file });
        continue;
      }
      const prev = isin ? by.get(isin) : undefined;
      if (prev) {
        prev.units = (prev.units ?? 0) + (r.units ?? 0) || undefined;
        if (r.file && !prev.files?.includes(r.file)) prev.files = [...(prev.files ?? []), r.file];
        continue;
      }
      const row: DraftRow = { key: uid(), isin, units: r.units && r.units > 0 ? r.units : undefined, nameHint: r.nameHint, confidence: r.confidence, customTerms: r.customTerms, acquiredOn: r.acquiredOn, investedAmount: r.investedAmount, purchaseYield: r.purchaseYield, files: r.file ? [r.file] : undefined };
      rows.push(row);
      if (isin) by.set(isin, row);
    }
    return { rows, skipped };
  }

  private reviewRows(rowsIn: DraftRow[]): ReviewRow[] {
    return rowsIn.map((r0) => {
      const r = { ...r0, isin: r0.isin ? normaliseIsin(r0.isin) : undefined };
      const already = this.holdings.filter((h) => h.isin === r.isin).map((h) => ({ portfolioId: h.portfolioId, name: this.portfolios.find((p) => p.id === h.portfolioId)!.name, units: h.units }));
      const base = { ...r, alreadyIn: already };
      if (!r.isin || !isValidIsin(r.isin)) {
        const word = (r.nameHint ?? '').split(/\s+/)[0]?.toLowerCase() ?? '';
        const suggestions = word.length > 2 ? [...BOND.values()].filter((b) => b.name.toLowerCase().includes(word)).slice(0, 3).map((b) => ({ isin: b.isin, name: b.name })) : [];
        return { ...base, status: 'bad_isin' as const, suggestions, note: r.isin ? `“${r.isin}” is not a valid ISIN. Correct it or remove this bond.` : 'ISIN not found. Enter the ISIN or remove this bond.' };
      }
      const t = BOND.get(r.isin);
      const bond = t ? { name: t.name, issuer: t.issuer, rating: t.rating, couponRate: t.couponRate, frequency: t.frequency, maturityDate: t.maturityDate, faceValue: t.faceValue } : undefined;
      if (!(r.units && r.units > 0)) return { ...base, bond, status: 'needs_units' as const, note: 'Units not found. Enter the number of units held.' };
      if (!t && !r.customTerms) return { ...base, notify: true, status: 'awaiting' as const, note: 'Bond details will be fetched automatically. Excluded from totals until then.' };
      if (!t && r.customTerms) return { ...base, status: 'your_details' as const, note: 'Using the details you entered. They will be verified once exchange data is available.' };
      if (!r.ok && t && r.units >= t.faceValue && r.units % t.faceValue === 0)
        return { ...base, bond, status: 'check' as const, suggestedUnits: r.units / t.faceValue, note: `This value looks like an amount. Did you mean ${r.units / t.faceValue} units?` };
      if (r.confidence === 'low' && !r.ok) return { ...base, bond, status: 'check' as const, note: 'Read from your file. Please confirm the units match your statement.' };
      return { ...base, bond, status: 'ready' as const };
    });
  }

  async pendingImport() {
    const list = [...this.imports.entries()].filter(([, v]) => !v.committed && v.rows.length);
    if (!list.length) return null;
    const [id, v] = list[list.length - 1];
    return { importId: id, files: v.files, rows: this.reviewRows(v.rows), skipped: v.skipped, statementDate: v.statementDate, createdAt: v.createdAt };
  }

  /** v2 feature, off in v1 like the server's EH_OWNERSHIP_CHECK. */
  ownershipCheck = false;

  private ownership(ids: string[], removed: string[] = []) {
    if (!this.ownershipCheck) return { enabled: false, overall: 'self' as Ownership, files: [] as { filename: string; owner: Ownership; pan?: string; holder?: string }[] };
    const files: { filename: string; owner: Ownership; pan?: string; holder?: string }[] = [];
    let manual = false;
    for (const id of ids) {
      const imp = this.imports.get(id);
      if (!imp) continue;
      if (imp.manual) manual = true;
      for (const f of imp.files) if (f.status === 'read' && !removed.includes(f.filename)) files.push({ filename: f.filename, owner: f.owner ?? 'unknown', pan: f.pan, holder: f.holder });
    }
    const list = files.map((f) => f.owner);
    if (manual || !files.length) list.push('unknown');
    return { enabled: true, overall: combineOwnership(list), files };
  }

  async review(id: string, rows: DraftRow[], opts: { replacePortfolioId?: string; alsoImportIds?: string[]; removedFiles?: string[] } = {}) {
    const replacePortfolioId = opts.replacePortfolioId;
    const ownership = this.ownership([id, ...(opts.alsoImportIds ?? [])], opts.removedFiles);
    const stPan = ownership.files.find((f) => f.pan)?.pan ?? null;
    for (const r of rows) if (r.customTerms) {
      const err = validateCustomTerms(r.customTerms, this.today);
      if (err) throw new ApiError(400, 'invalid_details', err);
    }
    const imp = this.imports.get(id);
    if (imp) imp.rows = rows;
    const out = this.reviewRows(rows);
    const committable = out.length > 0 && !out.some((r) => BLOCKING.includes(r.status));
    let match = null;
    const notices: { kind: string; message: string }[] = [];
    const sd = imp?.statementDate ?? null;
    if (committable) {
      const usable = out.map((r) => ({ isin: r.isin!, units: r.units! }));
      const cands = this.portfolios
        .filter((p) => !replacePortfolioId || p.id === replacePortfolioId)
        .filter((p) => (ownership.overall === 'other' ? p.ownerType === 'family' : p.ownerType !== 'family' || ownership.overall !== 'self'))
        .filter((p) => !stPan || !p.ownerPan || p.ownerPan === stPan)
        .map((p) => ({ id: p.id, name: p.name, rows: this.holdings.filter((h) => h.portfolioId === p.id).map((h) => ({ isin: h.isin, units: h.units })) }));
      const m = findMatch(usable, cands);
      if (m) {
        const diff = diffRows(cands.find((c) => c.id === m.portfolioId)!.rows, usable);
        const names: Record<string, string> = {};
        for (const i of [...diff.added, ...diff.removed, ...diff.changed.map((c) => c.isin)]) if (BOND.get(i)) names[i] = BOND.get(i)!.name;
        const saved = this.portfolios.find((p) => p.id === m.portfolioId)!.statementDate;
        const older = !!(saved && sd && sd < saved);
        match = { ...m, diff, names, savedStatementDate: saved, olderThanSaved: older };
        if (older) notices.push({ kind: 'older_statement', message: `This statement is dated ${formatDateNumeric(sd)}, older than the one already saved (${formatDateNumeric(saved)}). Holdings may be out of date.` });
      }
    }
    if (!notices.length && sd && (Date.parse(this.today) - Date.parse(sd)) / 864e5 > 30)
      notices.push({ kind: 'old_statement', message: `This statement is dated ${formatDateNumeric(sd)}. Holdings may have changed since then.` });
    return this.wait({ rows: out, committable, match, statementDate: sd, notices, ownership }, 200);
  }

  async commit(id: string, body: CommitBody) {
    if (!this.consented) throw new ApiError(403, 'consent_required', 'Tick the box to agree before saving');
    const own = this.ownership([id, ...(body.alsoImportIds ?? [])], body.removedFiles);
    if (own.overall === 'other' && body.ownership?.kind !== 'family')
      throw new ApiError(422, 'ownership_unconfirmed', 'This statement is in someone else’s name. Confirm it is a family member’s and you have their permission, or remove the file.');
    if (own.overall === 'unknown' && !body.ownership) throw new ApiError(422, 'ownership_unconfirmed', 'Confirm these are your or your family’s holdings.');
    const fam = body.ownership?.kind === 'family';
    const ownerPan = (own.files.find((f) => f.owner === 'other') ?? own.files.find((f) => f.owner === 'self'))?.pan ?? null;
    const imp = this.imports.get(id);
    if (imp?.committed) throw new ApiError(409, 'already_committed', 'These holdings were already saved');
    for (const extra of body.alsoImportIds ?? []) {
      const e = this.imports.get(extra);
      if (e) (e.committed = true), e.names.forEach((n) => this.seenFiles.add(n));
    }
    let pid: string;
    let name: string;
    let added = 0;
    let sold = 0;
    const add = (r: CommitBody['rows'][number], pid: string) =>
      this.holdings.push({ id: uid(), portfolioId: pid, isin: r.isin, units: r.units, customTerms: r.customTerms, acquiredOn: r.acquiredOn, investedAmount: r.investedAmount, purchaseYield: r.purchaseYield, awaiting: !!r.notify && !BOND.has(r.isin) && !r.customTerms, trackedFrom: this.today });
    if (body.mode === 'append') {
      let p = body.newHolding ? undefined : this.portfolios.find((x) => x.id === body.portfolioId) ?? this.portfolios[0];
      if (!p) {
        let i = 1;
        while (this.portfolios.some((x) => x.name.toLowerCase() === `holding ${i}`)) i++;
        const nm = `Holding ${i}`;
        p = { id: uid(), name: nm, createdAt: this.today, statementDate: null, ownerType: 'self', ownerLabel: null, ownerPan: null };
        this.portfolios.push(p);
      }
      pid = p.id;
      name = p.name;
      const replace = new Set((body.replaceLots ?? []).map((l) => `${l.isin}|${l.acquiredOn}`));
      this.holdings = this.holdings.filter((h) => !(h.portfolioId === pid && replace.has(`${h.isin}|${h.acquiredOn}`)));
      body.rows.forEach((r) => add(r, pid));
      added = body.rows.length;
    } else if (body.mode === 'new') {
      pid = uid();
      const label = body.ownership?.label?.trim() || null;
      const base = fam ? `${label ?? 'Family'}’s holdings` : 'My holdings';
      name = base;
      for (let i = 2; this.portfolios.some((p) => p.name.toLowerCase() === name.toLowerCase()); i++) name = `${base} ${i}`;
      this.portfolios.push({ id: pid, name, createdAt: this.today, statementDate: imp?.statementDate ?? null, ownerType: fam ? 'family' : 'self', ownerLabel: fam ? label : null, ownerPan });
      body.rows.forEach((r) => add(r, pid));
      added = body.rows.length;
    } else {
      const p = this.portfolios.find((x) => x.id === body.portfolioId)!;
      if (fam && p.ownerType !== 'family') throw new ApiError(422, 'owner_mismatch', 'Family holdings are kept separate. Add them as a separate holding.');
      pid = p.id;
      name = p.name;
      const have = new Set(this.holdings.filter((h) => h.portfolioId === pid).map((h) => h.isin));
      if (body.mode === 'add_new_only') {
        for (const r of body.rows.filter((r) => !have.has(r.isin))) {
          add(r, pid);
          added++;
        }
      } else {
        const soldSet = new Set((body.soldIsins ?? []).filter((i) => have.has(i)));
        sold = soldSet.size;
        this.holdings = this.holdings.filter((h) => h.portfolioId !== pid || !soldSet.has(h.isin));
        for (const r of body.rows) {
          const ex = this.holdings.find((h) => h.portfolioId === pid && h.isin === r.isin);
          if (ex) ex.units = r.units;
          else {
            add(r, pid);
            added++;
          }
        }
        if (imp?.statementDate && (!p.statementDate || imp.statementDate > p.statementDate)) p.statementDate = imp.statementDate;
      }
    }
    if (imp) {
      imp.committed = true;
      imp.names.forEach((n) => this.seenFiles.add(n));
    }
    const { items, awaiting } = this.items(pid);
    this.emit();
    return this.wait({ portfolioId: pid, name, added, sold, summary: summarise(items, this.today, this.received, CAL), holdingsCount: items.length, awaitingCount: awaiting.length }, 400);
  }
  async discard(id: string) {
    this.imports.delete(id);
  }
  async rename(id: string, name: string) {
    const p = this.portfolios.find((x) => x.id === id)!;
    p.name = name.trim();
    this.emit();
    return { name: p.name };
  }
  async deletePortfolio(id: string) {
    this.portfolios = this.portfolios.filter((p) => p.id !== id);
    this.holdings = this.holdings.filter((h) => h.portfolioId !== id);
    this.emit();
  }
  async removeHolding(holdingId: string) {
    const h = this.holdings.find((x) => x.id === holdingId);
    if (!h) throw new ApiError(404, 'holding_not_found', 'Holding not found');
    this.holdings = this.holdings.filter((x) => x.id !== holdingId);
    const portfolioDeleted = !this.holdings.some((x) => x.portfolioId === h.portfolioId);
    if (portfolioDeleted) this.portfolios = this.portfolios.filter((p) => p.id !== h.portfolioId);
    this.emit();
    return { portfolioDeleted };
  }
}
