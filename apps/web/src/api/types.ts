import type { CustomTerms, Frequency, PayoutEvent, PayoutStatus, PortfolioReport, PortfolioSummary } from '@eh/core';

export type { CustomTerms, PayoutStatus, PortfolioReport };

export interface PortfolioDto {
  id: string;
  name: string;
  source: 'bondscanner' | 'external';
  createdAt: string;
  statementDate: string | null;
  holdingsCount: number;
  principal: number;
  ownerType: 'self' | 'family';
  ownerLabel: string | null;
  /** Masked, e.g. XXXXX5678K. */
  ownerPan: string | null;
}

export interface HoldingDto {
  id: string;
  portfolioId: string;
  isin: string;
  name: string;
  issuer: string;
  rating: string;
  couponRate: number;
  frequency: Frequency;
  maturityDate: string;
  faceValue: number;
  units: number;
  principal: number;
  verified: boolean;
  matured: boolean;
  /** From Add manually (or the statement), when known. */
  investedAmount?: number | null;
  investedOn?: string | null;
  purchaseYield?: number | null;
}

export interface Overview {
  today: string;
  scope: string;
  summary: PortfolioSummary;
  portfolios: PortfolioDto[];
  holdings: HoldingDto[];
  /** "Notify me" bonds: listed as Details awaited, out of totals. */
  /** Bonds saved with ISIN + quantity only; we fetch their details on every sync. */
  /** Bonds not in our data yet. `entered`: the user added their investment details (counted in totals). */
  awaiting: { id: string; portfolioId: string; isin: string; units: number; name: string; detailsRequested?: boolean; investedAmount?: number; investedOn?: string; purchaseYield?: number; entered?: boolean }[];
  overlaps: { isin: string; portfolioIds: string[] }[];
}

export type Payout = PayoutEvent & { status: PayoutStatus; portfolioName?: string };

export interface DraftRow {
  key: string;
  isin?: string;
  units?: number;
  investedAmount?: number;
  acquiredOn?: string;
  purchaseYield?: number;
  nameHint?: string;
  confidence: 'high' | 'low';
  customTerms?: CustomTerms;
  notify?: boolean;
  ok?: boolean;
  files?: string[];
}

export type RowStatus = 'ready' | 'check' | 'your_details' | 'awaiting' | 'not_found' | 'bad_isin' | 'needs_units';
export const BLOCKING: RowStatus[] = ['not_found', 'bad_isin', 'needs_units'];

export interface ReviewRow extends DraftRow {
  status: RowStatus;
  bond?: { name: string; issuer: string; rating?: string; couponRate: number; frequency: Frequency; maturityDate: string; faceValue: number };
  suggestions?: { isin: string; name: string }[];
  suggestedUnits?: number;
  note?: string;
  alreadyIn?: { portfolioId: string; name: string; units: number }[];
}

export type FileStatus = 'read' | 'empty' | 'only_non_bonds' | 'password_required' | 'password_incorrect' | 'unreadable' | 'unsupported' | 'duplicate_file';
export interface FileResult {
  index: number;
  filename: string;
  status: FileStatus;
  bonds: number;
  statementDate?: string;
  message?: string;
  owner?: Ownership;
  pan?: string;
  holder?: string;
}

export type Ownership = 'self' | 'other' | 'unknown';
export interface OwnershipInfo {
  /** False in v1 (no ownership step). v2 turns it on with EH_OWNERSHIP_CHECK. */
  enabled: boolean;
  overall: Ownership;
  files: { filename: string; owner: Ownership; pan?: string; holder?: string }[];
}

export interface ImportDraft {
  importId: string;
  files: FileResult[];
  rows: ReviewRow[];
  skipped: { isin: string; reason: string; name?: string; file?: string }[];
  statementDate: string | null;
}

export interface MatchInfo {
  portfolioId: string;
  portfolioName: string;
  type: 'same' | 'update';
  coverage: number;
  shared: number;
  diff: { added: string[]; removed: string[]; changed: { isin: string; from: number; to: number }[]; unchanged: string[] };
  names?: Record<string, string>;
  savedStatementDate?: string | null;
  olderThanSaved?: boolean;
}

export interface ReviewResult {
  rows: ReviewRow[];
  committable: boolean;
  match: MatchInfo | null;
  statementDate: string | null;
  notices: { kind: string; message: string }[];
  ownership: OwnershipInfo;
}

export type CommitMode = 'new' | 'replace' | 'add_new_only' | 'append';
export interface CommitBody {
  rows: { isin: string; units: number; acquiredOn?: string; investedAmount?: number; purchaseYield?: number; issuerName?: string; customTerms?: CustomTerms; notify?: boolean }[];
  mode: CommitMode;
  portfolioId?: string;
  soldIsins?: string[];
  /** append: save into a new holding instead of an existing one. */
  newHolding?: boolean;
  /** append: saved rows (same ISIN and date of investment) replaced by this upload's rows. */
  replaceLots?: { isin: string; acquiredOn: string }[];
  /** Extra imports (more files, typed bonds), closed together with this one. */
  alsoImportIds?: string[];
  /** Files the user removed on the Confirm screen (e.g. someone else's statement). */
  removedFiles?: string[];
  /** Whose holdings: required when a file is in someone else's name, or no PAN was found. */
  ownership?: { kind: 'self' | 'family'; label?: string };
}
export interface CommitResult {
  portfolioId: string;
  name: string;
  added: number;
  sold: number;
  summary: PortfolioSummary;
  holdingsCount: number;
  awaitingCount: number;
}

export interface BondHit {
  isin: string;
  name: string;
  issuer: string;
  rating?: string;
  couponRate: number;
  frequency: Frequency;
  maturityDate: string;
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

/** Everything the UI needs. HTTP in production, in-memory for the demo build. */
export interface Api {
  status(): Promise<{ consented: boolean; externalPortfolios: number }>;
  consent(): Promise<void>;
  /** Name and email the visitor gave on first use (null before that). */
  profile(): Promise<{ name: string; email: string } | null>;
  setProfile(v: { name: string; email: string }): Promise<void>;
  /** Funnel steps only the browser sees. Never throws. */
  trackEvent(name: 'eh_add_opened' | 'eh_template_downloaded' | 'eh_click', props?: Record<string, string | number>): void;
  /** "Send us your holdings in any format": our team adds them within 24 hours. */
  sendAssisted(file: File, note?: string): Promise<{ id: string }>;
  myAssisted(): Promise<AssistedRequest[]>;
  overview(scope?: string): Promise<Overview>;
  payouts(opts?: { scope?: string; from?: string; to?: string }): Promise<{ today: string; payouts: Payout[] }>;
  setReceived(holdingId: string, scheduledDate: string, received: boolean): Promise<void>;
  /** Add details: date of investment, units, invested amount, yield. */
  setInvestment(holdingId: string, v: Investment): Promise<void>;
  /** Add bond terms for a bond still awaiting data (kept for API compatibility). */
  addDetails(holdingId: string, terms: CustomTerms): Promise<void>;
  report(scope?: string): Promise<PortfolioReport>;
  searchBonds(q: string): Promise<BondHit[]>;
  uploadFiles(files: { file: File; password?: string }[]): Promise<ImportDraft>;
  manual(rows: { isin: string; units: number; acquiredOn?: string; investedAmount?: number; purchaseYield?: number; nameHint?: string; customTerms?: CustomTerms }[]): Promise<ImportDraft>;
  pendingImport(): Promise<(ImportDraft & { createdAt: string }) | null>;
  review(importId: string, rows: DraftRow[], opts?: { replacePortfolioId?: string; alsoImportIds?: string[]; removedFiles?: string[] }): Promise<ReviewResult>;
  commit(importId: string, body: CommitBody): Promise<CommitResult>;
  discard(importId: string): Promise<void>;
  rename(portfolioId: string, name: string): Promise<{ name: string }>;
  deletePortfolio(portfolioId: string): Promise<void>;
  /** Remove one bond; the holding is deleted when its last bond goes. */
  removeHolding(holdingId: string): Promise<{ portfolioDeleted: boolean }>;
}

export interface AssistedRequest {
  id: string;
  fileName: string;
  status: 'received' | 'done';
  createdAt: string;
  doneAt: string | null;
}

export interface Investment {
  units: number;
  acquiredOn: string;
  investedAmount: number;
  purchaseYield: number;
  /** Issuer name as the user wrote it (template or Add manually). */
  issuerName?: string;
}
