import { createHash, randomUUID } from 'node:crypto';
import { combineOwnership, isValidIsin, maskPan, normaliseIsin, panOwnership, type BondTerms, type CustomTerms, type Ownership } from '@eh/core';
import { isoDate, type Db } from '../db';
import { detectMethod, parseFile, PdfPasswordError, type ParsedRow } from '../parsers';
import type { OcrEngine } from '../parsers/image';
import type { IsinDirectory, UserProfileProvider } from '../providers/types';
import type { BondService } from './bonds';
import { HttpError } from './holdings';

export const MAX_FILES = 5;

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
  /** User tapped "Notify me": we do not have this bond yet. Saved, but out of totals. */
  notify?: boolean;
  /** User confirmed a "Check" row as correct. */
  ok?: boolean;
  /** Which uploaded file(s) the row came from. */
  files?: string[];
}

export type RowStatus =
  | 'ready'
  | 'check'
  | 'your_details'
  | 'awaiting'
  | 'not_found'
  | 'bad_isin'
  | 'needs_units';

export interface ReviewRow extends DraftRow {
  status: RowStatus;
  bond?: Pick<BondTerms, 'name' | 'issuer' | 'rating' | 'couponRate' | 'frequency' | 'maturityDate' | 'faceValue'>;
  suggestions?: { isin: string; name: string }[];
  suggestedUnits?: number;
  note?: string;
}

/** Statuses that stop "Confirm and save". */
export const BLOCKING: RowStatus[] = ['not_found', 'bad_isin', 'needs_units'];

export type FileStatus = 'read' | 'empty' | 'only_non_bonds' | 'password_required' | 'password_incorrect' | 'unreadable' | 'unsupported' | 'duplicate_file';

export interface FileResult {
  index: number;
  filename: string;
  status: FileStatus;
  bonds: number;
  statementDate?: string;
  message?: string;
  /** Whose holdings: the user's (PAN matches KYC), someone else's, or unknown (no PAN printed). */
  owner?: Ownership;
  /** Masked PAN printed on the file, e.g. XXXXX5678K. Never the full PAN. */
  pan?: string;
  holder?: string;
}

export interface OwnershipInfo {
  /** False in v1: no ownership step is shown or enforced. */
  enabled: boolean;
  overall: Ownership;
  files: { filename: string; owner: Ownership; pan?: string; holder?: string }[];
}

const FILE_MESSAGE: Record<Exclude<FileStatus, 'read'>, string> = {
  empty: 'No holdings found in this file.',
  only_non_bonds: 'Only shares or mutual funds found. External Holdings tracks bonds.',
  password_required: 'This PDF is locked. Enter its password and try again.',
  password_incorrect: 'That password did not work. CAS passwords are usually your PAN in capitals.',
  unreadable: 'We could not read this file. Retry, or upload a clearer copy.',
  unsupported: 'Upload a PDF, Excel (.xlsx), CSV or a screenshot (PNG, JPG).',
  duplicate_file: 'You already added this exact file before, so it was skipped.',
};

export class ImportService {
  constructor(
    private readonly db: Db,
    private readonly bonds: BondService,
    private readonly directory: IsinDirectory,
    private readonly ocr: OcrEngine,
    private readonly profile: UserProfileProvider,
    /** v2 feature (EH_OWNERSHIP_CHECK). When off, no PAN is read, compared or stored. */
    readonly ownershipCheck = false,
  ) {}

  /**
   * Read up to 5 files. Each file succeeds or fails on its own; good files go through
   * even if another fails. Rows from all files are merged: the same ISIN twice adds units.
   */
  async fromFiles(userId: string, files: { filename: string; mime: string; data: Uint8Array; password?: string }[]) {
    if (!files.length) throw new HttpError(400, 'file_required', 'Choose at least one file');
    if (files.length > MAX_FILES) throw new HttpError(400, 'too_many_files', `Add up to ${MAX_FILES} files at a time`);
    const results: FileResult[] = [];
    const parsed: (ParsedRow & { file: string })[] = [];
    const hashes: string[] = [];
    const userPan = this.ownershipCheck ? await this.profile.kycPan(userId) : undefined;
    let statementDate: string | undefined;
    const methods = files.map((f) => detectMethod(f.filename, f.mime, f.data));

    for (const [index, f] of files.entries()) {
      const r: FileResult = { index, filename: f.filename, status: 'read', bonds: 0 };
      results.push(r);
      const method = methods[index];
      if (!method) {
        r.status = 'unsupported';
        continue;
      }
      const sha = createHash('sha256').update(f.data).digest('hex');
      if (hashes.includes(sha) || (await this.seenBefore(userId, sha))) {
        r.status = 'duplicate_file';
        continue;
      }
      try {
        // Copy: pdf.js takes ownership of (detaches) the buffer it is given.
        const res = await parseFile(method, new Uint8Array(f.data), { password: f.password, ocr: this.ocr });
        hashes.push(sha);
        if (this.ownershipCheck) {
          r.owner = panOwnership(res.identity?.pan, userPan);
          if (res.identity?.pan) r.pan = maskPan(res.identity.pan.replace(/\*/g, 'X'));
          if (res.identity?.holder) r.holder = res.identity.holder;
        }
        if (res.statementDate) {
          r.statementDate = res.statementDate;
          if (!statementDate || res.statementDate > statementDate) statementDate = res.statementDate;
        }
        for (const row of res.rows) parsed.push({ ...row, file: f.filename });
      } catch (e) {
        r.status = e instanceof PdfPasswordError ? (e.reason === 'required' ? 'password_required' : 'password_incorrect') : 'unreadable';
      }
      // The file buffer goes out of scope here and is never written anywhere.
    }

    const { rows, skipped } = await this.filterAndMerge(parsed);
    for (const r of results) {
      if (r.status !== 'read') continue;
      r.bonds = rows.filter((x) => x.files?.includes(r.filename)).length;
      if (!r.bonds) r.status = skipped.some((s) => s.file === r.filename) ? 'only_non_bonds' : 'empty';
    }
    for (const r of results) if (r.status !== 'read') r.message = FILE_MESSAGE[r.status];

    const id = randomUUID();
    await this.db.query(
      `INSERT INTO eh_imports (id, user_id, method, file_sha256, file_hashes, parser, rows, skipped, files, statement_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, userId, methods.find((m) => m) ?? 'pdf', hashes[0] ?? null, hashes, 'multi', JSON.stringify(rows), JSON.stringify(skipped), JSON.stringify(results), statementDate ?? null],
    );
    return { importId: id, files: results, rows: await this.review(rows), skipped, statementDate: statementDate ?? null };
  }

  async manual(userId: string, input: Omit<DraftRow, 'key' | 'confidence'>[]) {
    const { rows, skipped } = await this.filterAndMerge(input.map((r) => ({ ...r, confidence: 'high' as const, file: '' })));
    const id = randomUUID();
    await this.db.query(`INSERT INTO eh_imports (id, user_id, method, parser, rows, skipped) VALUES ($1,$2,'manual','manual',$3,$4)`, [id, userId, JSON.stringify(rows), JSON.stringify(skipped)]);
    return { importId: id, files: [] as FileResult[], rows: await this.review(rows), skipped, statementDate: null };
  }

  private async seenBefore(userId: string, sha: string) {
    // Only while the holding saved from that file still exists: after the user deletes it, the same file can be added again.
    const r = await this.db.query(
      `SELECT 1 FROM eh_imports i JOIN eh_portfolios p ON p.id = i.committed_portfolio_id AND p.deleted_at IS NULL
        WHERE i.user_id=$1 AND i.status='committed' AND $2 = ANY(i.file_hashes)
          AND EXISTS (SELECT 1 FROM eh_holdings h WHERE h.portfolio_id = p.id) LIMIT 1`,
      [userId, sha],
    );
    return r.length > 0;
  }

  /** Skip shares/MFs, merge duplicates across files (units add up). The same ISIN with different dates of investment stays separate. */
  private async filterAndMerge(parsed: (Partial<DraftRow> & { isin?: string; units?: number; confidence: 'high' | 'low'; file: string; invalidIsin?: boolean })[]) {
    const valid = parsed.map((r) => r.isin).filter((x): x is string => !!x && isValidIsin(x));
    const info = await this.directory.lookup(valid);
    const skipped: { isin: string; reason: string; name?: string; file: string }[] = [];
    const rows: DraftRow[] = [];
    const byLot = new Map<string, DraftRow>();
    for (const r of parsed) {
      const isin = r.isin ? normaliseIsin(r.isin) : undefined;
      const i = isin ? info.get(isin) : undefined;
      if (i && (i.instrumentType === 'equity' || i.instrumentType === 'mutual_fund')) {
        skipped.push({ isin: isin!, reason: i.instrumentType, name: i.name ?? r.nameHint, file: r.file });
        continue;
      }
      const lot = isin ? `${isin}|${r.acquiredOn ?? ''}` : undefined;
      const prev = lot ? byLot.get(lot) : undefined;
      if (prev) {
        prev.units = (prev.units ?? 0) + (r.units ?? 0) || undefined;
        if (r.investedAmount != null) prev.investedAmount = (prev.investedAmount ?? 0) + r.investedAmount;
        if (r.file && !prev.files?.includes(r.file)) prev.files = [...(prev.files ?? []), r.file];
        prev.confidence = 'low';
        continue;
      }
      const row: DraftRow = {
        key: randomUUID().slice(0, 8),
        isin,
        units: r.units && r.units > 0 ? r.units : undefined,
        investedAmount: r.investedAmount,
        acquiredOn: r.acquiredOn,
        purchaseYield: (r as { purchaseYield?: number }).purchaseYield,
        customTerms: r.customTerms,
        notify: r.notify,
        nameHint: r.nameHint,
        confidence: r.confidence,
        files: r.file ? [r.file] : undefined,
      };
      rows.push(row);
      if (lot) byLot.set(lot, row);
    }
    return { rows, skipped };
  }

  async get(userId: string, id: string) {
    const r = await this.db.query<{ id: string; status: string; rows: DraftRow[]; skipped: unknown[]; files: FileResult[]; method: string; statement_date: string | null; created_at: string }>(
      `SELECT id, status, rows, skipped, files, method, statement_date, created_at FROM eh_imports WHERE id=$1 AND user_id=$2`,
      [id, userId],
    );
    if (!r.length) throw new HttpError(404, 'import_not_found', 'Import not found');
    return { ...r[0], statement_date: r[0].statement_date ? isoDate(r[0].statement_date) : null };
  }

  /** Unfinished import from the last 7 days, so a user who left mid-way can continue. */
  async pending(userId: string) {
    const r = await this.db.query<{ id: string }>(
      `SELECT id FROM eh_imports WHERE user_id=$1 AND status='parsed' AND jsonb_array_length(rows) > 0
         AND created_at > now() - interval '7 days' ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    if (!r.length) return null;
    const imp = await this.get(userId, r[0].id);
    return { importId: imp.id, rows: await this.review(imp.rows), skipped: imp.skipped, files: imp.files, statementDate: imp.statement_date, createdAt: imp.created_at };
  }

  async saveRows(userId: string, id: string, rows: DraftRow[]) {
    await this.db.query(`UPDATE eh_imports SET rows=$1 WHERE id=$2 AND user_id=$3 AND status='parsed'`, [JSON.stringify(rows), id, userId]);
  }

  /** Validate and enrich rows for the check screen. Stateless: the client sends its edited rows. */
  async review(rowsIn: DraftRow[]): Promise<ReviewRow[]> {
    const rows = rowsIn.map((r) => ({ ...r, isin: r.isin ? normaliseIsin(r.isin) : undefined }));
    // Verified exchange data always wins over what the user typed.
    const terms = await this.bonds.getMany(rows.filter((r) => r.isin && isValidIsin(r.isin)).map((r) => r.isin!));
    const out: ReviewRow[] = [];
    for (const r of rows) {
      if (!r.isin || !isValidIsin(r.isin)) {
        const word = r.nameHint?.split(/\s+/).slice(0, 2).join(' ');
        const suggestions = word && word.length > 2 ? (await this.bonds.search(word, 3)).map((b) => ({ isin: b.isin, name: b.name })) : [];
        out.push({ ...r, status: 'bad_isin', suggestions, note: r.isin ? `“${r.isin}” is not a valid ISIN. Correct it or remove this bond.` : 'ISIN not found. Enter the ISIN or remove this bond.' });
        continue;
      }
      const t = terms.get(r.isin);
      const bond = t
        ? { name: t.name, issuer: t.issuer, rating: t.rating, couponRate: t.couponRate, frequency: t.frequency, maturityDate: t.maturityDate, faceValue: t.faceValue }
        : undefined;
      if (!(r.units && r.units > 0)) {
        out.push({ ...r, bond, status: 'needs_units', note: 'Units not found. Enter the number of units held.' });
        continue;
      }
      // Not in our data yet: no action needed. We fetch it on every sync and update it;
      // if it is still missing after a day, we remind the user to add the details.
      if (!t && !r.customTerms) {
        out.push({ ...r, notify: true, status: 'awaiting', note: 'Bond details will be fetched automatically. Excluded from totals until then.' });
        continue;
      }
      if (!t && r.customTerms) {
        out.push({ ...r, status: 'your_details', note: 'Using the details you entered. They will be verified once exchange data is available.' });
        continue;
      }
      // Hints never block (product decision): the user can keep exactly what they have.
      if (!r.ok && t && r.units >= t.faceValue && r.units % t.faceValue === 0) {
        out.push({ ...r, bond, status: 'check', suggestedUnits: r.units / t.faceValue, note: `This value looks like an amount. Did you mean ${r.units / t.faceValue} units?` });
        continue;
      }
      if (!r.ok && t && t.maturityDate < new Date().toISOString().slice(0, 10)) {
        out.push({ ...r, bond, status: 'check', note: 'This bond has matured. No further payouts are due.' });
        continue;
      }
      out.push({ ...r, bond, status: r.confidence === 'low' && !r.ok ? 'check' : 'ready', note: r.confidence === 'low' && !r.ok ? 'Read from your file. Please confirm the units match your statement.' : undefined });
    }
    return out;
  }

  /** Ownership across one or more imports (main + files added later), minus files the user removed. */
  async ownership(userId: string, ids: string[], removedFiles: string[] = []): Promise<OwnershipInfo> {
    if (!this.ownershipCheck) return { enabled: false, overall: 'self', files: [] };
    const files: OwnershipInfo['files'] = [];
    let anyManual = false;
    for (const id of ids) {
      const imp = await this.get(userId, id);
      if (imp.method === 'manual') anyManual = true;
      for (const f of imp.files ?? [])
        if (f.status === 'read' && !removedFiles.includes(f.filename)) files.push({ filename: f.filename, owner: f.owner ?? 'unknown', pan: f.pan, holder: f.holder });
    }
    const list = files.map((f) => f.owner);
    if (anyManual || !files.length) list.push('unknown');
    return { enabled: true, overall: combineOwnership(list), files };
  }

  static isCommittable(rows: ReviewRow[]) {
    return rows.length > 0 && !rows.some((r) => BLOCKING.includes(r.status));
  }

  async markCommitted(userId: string, id: string, portfolioId: string) {
    await this.db.query(
      `UPDATE eh_imports SET status='committed', committed_portfolio_id=$1, committed_at=now(), rows='[]' WHERE id=$2 AND user_id=$3`,
      [portfolioId, id, userId],
    );
  }

  async discard(userId: string, id: string) {
    await this.db.query(`UPDATE eh_imports SET status='discarded', rows='[]' WHERE id=$1 AND user_id=$2`, [id, userId]);
  }
}
