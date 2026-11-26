import { randomUUID } from 'node:crypto';
import { validateCustomTerms,
  allEvents,
  bondShortName,
  diffRows,
  findMatch,
  overlaps,
  payoutStatus,
  portfolioReport,
  withAutoReceived,
  summarise,
  taxStatement,
  todayIST,
  customToTerms,
  type CustomTerms,
  type HoldingWithTerms,
  type ISODate,
  type NotificationPrefs,
  DEFAULT_PREFS,
} from '@eh/core';
import { isoDate, type Db } from '../db';
import type { InternalHoldingsProvider } from '../providers/types';
import type { BondService, CalendarService } from './bonds';

export const BONDSCANNER_PORTFOLIO_ID = 'bondscanner';

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export type { CustomTerms };

type PortfolioRow = { id: string; name: string; created_at: string; statement_date: string | null; owner_type: 'self' | 'family'; owner_label: string | null; owner_pan_masked: string | null };
type HoldingRow = {
  id: string;
  portfolio_id: string;
  isin: string;
  units: number;
  invested_amount: number | null;
  acquired_on: string | null;
  purchase_yield?: string | number | null;
  issuer_name?: string | null;
  tracked_from: string;
  custom_terms: CustomTerms | null;
  awaiting: boolean;
  details_requested_at?: string | null;
};

export class HoldingsService {
  constructor(
    private readonly db: Db,
    private readonly bonds: BondService,
    private readonly calendar: CalendarService,
    private readonly internal: InternalHoldingsProvider,
    /** Product decision (Nov 2026): External Holdings totals cover external portfolios only. */
    private readonly includeBondScanner = false,
  ) {}

  // ---------- consent ----------
  async hasConsent(userId: string, version: string) {
    return (await this.db.query('SELECT 1 FROM eh_consents WHERE user_id=$1 AND version=$2', [userId, version])).length > 0;
  }
  async giveConsent(userId: string, version: string, ip?: string, ua?: string) {
    await this.db.query(
      `INSERT INTO eh_consents (user_id, version, ip, user_agent) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [userId, version, ip ?? null, ua ?? null],
    );
  }

  // ---------- loading ----------
  async portfolios(userId: string) {
    const ps = await this.db.query<PortfolioRow>(
      `SELECT id, name, created_at, statement_date, owner_type, owner_label, owner_pan_masked FROM eh_portfolios WHERE user_id=$1 AND deleted_at IS NULL ORDER BY created_at`,
      [userId],
    );
    const hs = ps.length
      ? await this.db.query<HoldingRow>(`SELECT * FROM eh_holdings WHERE portfolio_id = ANY($1) ORDER BY created_at, isin`, [ps.map((p) => p.id)])
      : [];
    return { ps, hs };
  }

  /** Every holding the user has, BondScanner first, with bond terms attached. */
  async items(userId: string, scope: string = 'all', today: string = todayIST()): Promise<{
    items: HoldingWithTerms[];
    missingTerms: string[];
    awaiting: { id: string; portfolioId: string; isin: string; units: number; detailsRequested: boolean; investedAmount?: number; investedOn?: string; purchaseYield?: number; issuerName?: string }[];
    portfolios: { id: string; name: string; source: 'bondscanner' | 'external'; createdAt: string; statementDate: string | null; ownerType: 'self' | 'family'; ownerLabel: string | null; ownerPan: string | null }[];
  }> {
    const { ps, hs } = await this.portfolios(userId);
    const own = this.includeBondScanner ? await this.internal.forUser(userId) : [];
    const isins = [...new Set([...hs.map((h) => h.isin), ...own.map((o) => o.isin)])];
    const terms = await this.bonds.getMany(isins);
    const portfolios = [
      ...(own.length ? [{ id: BONDSCANNER_PORTFOLIO_ID, name: 'Bought on BondScanner', source: 'bondscanner' as const, createdAt: '', statementDate: null, ownerType: 'self' as const, ownerLabel: null, ownerPan: null }] : []),
      ...ps.map((p) => ({
        id: p.id,
        name: p.name,
        source: 'external' as const,
        createdAt: String(p.created_at),
        statementDate: p.statement_date ? isoDate(p.statement_date) : null,
        ownerType: p.owner_type ?? 'self',
        ownerLabel: p.owner_label,
        ownerPan: p.owner_pan_masked,
      })),
    ];
    const items: HoldingWithTerms[] = [];
    const missingTerms: string[] = [];
    const awaiting: { id: string; portfolioId: string; isin: string; units: number; detailsRequested: boolean; investedAmount?: number; investedOn?: string; purchaseYield?: number; issuerName?: string }[] = [];
    if (scope === 'all' || scope === BONDSCANNER_PORTFOLIO_ID) {
      for (const o of own) {
        const t = terms.get(o.isin);
        if (!t) {
          missingTerms.push(o.isin);
          continue;
        }
        items.push({
          holding: { id: `bs:${o.isin}`, portfolioId: BONDSCANNER_PORTFOLIO_ID, isin: o.isin, units: o.units, investedAmount: o.investedAmount, acquiredOn: o.acquiredOn, trackedFrom: o.acquiredOn ?? '2000-01-01' },
          portfolio: { id: BONDSCANNER_PORTFOLIO_ID, name: 'Bought on BondScanner', source: 'bondscanner' },
          terms: t,
        });
      }
    }
    for (const h of hs) {
      if (scope !== 'all' && scope !== h.portfolio_id) continue;
      const p = ps.find((x) => x.id === h.portfolio_id)!;
      // Verified data (Deridata via SNAPE) replaces user-entered details as soon as it exists.
      const t = terms.get(h.isin) ?? (h.custom_terms ? customToTerms(h.isin, h.custom_terms, isoDate(h.tracked_from)) : undefined);
      if (!t) {
        // "Notify me" bonds (and any whose terms disappeared) stay listed as Details awaited, out of totals.
        awaiting.push({
          id: h.id,
          portfolioId: h.portfolio_id,
          isin: h.isin,
          units: Number(h.units),
          detailsRequested: !!h.details_requested_at,
          investedAmount: h.invested_amount != null ? Number(h.invested_amount) : undefined,
          investedOn: h.acquired_on ? isoDate(h.acquired_on) : undefined,
          purchaseYield: h.purchase_yield != null ? Number(h.purchase_yield) : undefined,
          issuerName: h.issuer_name ?? undefined,
        });
        if (!h.awaiting) missingTerms.push(h.isin);
        continue;
      }
      items.push({
        holding: {
          id: h.id,
          portfolioId: h.portfolio_id,
          isin: h.isin,
          units: Number(h.units),
          investedAmount: h.invested_amount != null ? Number(h.invested_amount) : undefined,
          acquiredOn: h.acquired_on ? isoDate(h.acquired_on) : undefined,
          purchaseYield: h.purchase_yield != null ? Number(h.purchase_yield) : undefined,
          trackedFrom: isoDate(h.tracked_from),
        },
        portfolio: { id: p.id, name: p.name, source: 'external' },
        terms: t,
      });
    }
    if (scope !== 'all' && !portfolios.some((p) => p.id === scope)) throw new HttpError(404, 'portfolio_not_found', 'We could not find this holding. Please refresh the page and try again.');
    void today;
    return { items, missingTerms, awaiting, portfolios };
  }

  async received(userId: string): Promise<Set<string>> {
    const rows = await this.db.query<{ holding_id: string; scheduled_date: string }>(
      `SELECT holding_id, scheduled_date FROM eh_payout_receipts WHERE user_id=$1`,
      [userId],
    );
    return new Set(rows.map((r) => `${r.holding_id}|${isoDate(r.scheduled_date)}`));
  }

  // ---------- read models ----------
  async overview(userId: string, scope = 'all', today: ISODate = todayIST()) {
    const [{ items, missingTerms, portfolios, awaiting }, stored, cal] = await Promise.all([
      this.items(userId, scope),
      this.received(userId),
      this.calendar.get(),
    ]);
    const received = withAutoReceived(items, today, stored, cal);
    const summary = summarise(items, today, received, cal);
    // Bonds not in our data yet but with the user's investment details: counted in principal and
    // yield using what the user entered. Payouts need bond terms, so they start once terms arrive.
    const entered = awaiting.filter((a) => a.investedAmount && a.investedOn);
    if (entered.length) {
      const enteredAmount = entered.reduce((s, a) => s + a.investedAmount!, 0);
      // Yield average: only bonds with a known yield count; one without a yield is left out, not taken as 0%.
      const withYield = entered.filter((a) => a.purchaseYield != null);
      const weight = summary.principal + withYield.reduce((s, a) => s + a.investedAmount!, 0);
      if (weight) summary.avgCoupon = Math.round(((summary.avgCoupon * summary.principal + withYield.reduce((s, a) => s + a.investedAmount! * a.purchaseYield!, 0)) / weight) * 100) / 100;
      // Entered yield, weighted by amount invested, across bonds with terms and these.
      if (withYield.length) {
        const known = items.filter((i) => i.holding.purchaseYield != null);
        const w = (i: HoldingWithTerms) => i.holding.investedAmount ?? i.holding.units * i.terms.faceValue;
        const num = known.reduce((s, i) => s + w(i) * i.holding.purchaseYield!, 0) + withYield.reduce((s, a) => s + a.investedAmount! * a.purchaseYield!, 0);
        const den = known.reduce((s, i) => s + w(i), 0) + withYield.reduce((s, a) => s + a.investedAmount!, 0);
        if (den) summary.enteredYield = Math.round((num / den) * 100) / 100;
      }
      summary.principal = Math.round((summary.principal + enteredAmount) * 100) / 100;
      summary.invested = Math.round((summary.invested + enteredAmount) * 100) / 100;
      summary.holdingsCount += entered.length;
    }
    const allData = scope === 'all' ? { items, awaiting } : await this.items(userId);
    return {
      today,
      scope,
      summary,
      portfolios: portfolios.map((p) => {
        const mine = allData.items.filter((i) => i.portfolio.id === p.id);
        const mineEntered = allData.awaiting.filter((a) => a.portfolioId === p.id && a.investedAmount && a.investedOn);
        return {
          ...p,
          holdingsCount: mine.length + mineEntered.length,
          principal: mine.reduce((s, i) => s + i.holding.units * i.terms.faceValue, 0) + mineEntered.reduce((s, a) => s + a.investedAmount!, 0),
        };
      }),
      holdings: items.map((i) => ({
        id: i.holding.id,
        portfolioId: i.portfolio.id,
        isin: i.terms.isin,
        name: i.terms.name,
        issuer: i.terms.issuer,
        rating: i.terms.rating ?? 'Unrated',
        couponRate: i.terms.couponRate,
        frequency: i.terms.frequency,
        maturityDate: i.terms.maturityDate,
        faceValue: i.terms.faceValue,
        units: i.holding.units,
        principal: i.holding.units * i.terms.faceValue,
        investedAmount: i.holding.investedAmount ?? null,
        investedOn: i.holding.acquiredOn ?? null,
        purchaseYield: i.holding.purchaseYield ?? null,
        verified: i.terms.verified,
        matured: i.terms.maturityDate < today,
        awaiting: false,
      })),
      awaiting: awaiting.map((a) => ({ ...a, name: a.issuerName || 'Details awaited', entered: !!(a.investedAmount && a.investedOn) })),
      overlaps: overlaps(
        portfolios.map((p) => ({ id: p.id, name: p.name, rows: items.filter((i) => i.portfolio.id === p.id).map((i) => ({ isin: i.terms.isin, units: i.holding.units })) })),
      ),
      missingTerms,
    };
  }

  async payouts(userId: string, opts: { scope?: string; from?: ISODate; to?: ISODate; today?: ISODate }) {
    const today = opts.today ?? todayIST();
    const [{ items }, stored, cal] = await Promise.all([this.items(userId, opts.scope ?? 'all'), this.received(userId), this.calendar.get()]);
    const received = withAutoReceived(items, today, stored, cal);
    const names = new Map(items.map((i) => [i.portfolio.id, i.portfolio.name]));
    return allEvents(items, cal, { from: opts.from, to: opts.to }).map((e) => ({
      ...e,
      portfolioName: names.get(e.portfolioId),
      status: payoutStatus(e, today, received),
    }));
  }

  async setReceived(userId: string, holdingId: string, scheduledDate: ISODate, receivedFlag: boolean) {
    const { items } = await this.items(userId);
    if (!items.some((i) => i.holding.id === holdingId)) throw new HttpError(404, 'holding_not_found', 'We could not find this bond. Please refresh the page and try again.');
    if (receivedFlag)
      await this.db.query(
        `INSERT INTO eh_payout_receipts (user_id, holding_id, scheduled_date) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [userId, holdingId, scheduledDate],
      );
    else
      await this.db.query(`DELETE FROM eh_payout_receipts WHERE user_id=$1 AND holding_id=$2 AND scheduled_date=$3`, [userId, holdingId, scheduledDate]);
  }

  async report(userId: string, scope = 'all') {
    const { items } = await this.items(userId, scope);
    return portfolioReport(items);
  }

  async taxStatement(userId: string, fy: string) {
    const [{ items }, stored, cal] = await Promise.all([this.items(userId), this.received(userId), this.calendar.get()]);
    const received = withAutoReceived(items, todayIST(), stored, cal);
    const st = taxStatement(items, fy, received, cal);
    const names = new Map(items.map((i) => [i.portfolio.id, i.portfolio.name]));
    return { ...st, rows: st.rows.map((r) => ({ ...r, portfolioName: names.get(r.portfolioId) })) };
  }

  // ---------- portfolio management ----------
  private async ownPortfolio(userId: string, id: string, db: Db = this.db) {
    if (id === BONDSCANNER_PORTFOLIO_ID) throw new HttpError(400, 'read_only', 'Bonds bought on BondScanner update by themselves');
    const r = await db.query<PortfolioRow>(`SELECT id, name, created_at, statement_date, owner_type, owner_label, owner_pan_masked FROM eh_portfolios WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, [id, userId]);
    if (!r.length) throw new HttpError(404, 'portfolio_not_found', 'Portfolio not found');
    return r[0];
  }

  /** Default name for a new holding from a template upload: the first free "Holding 1", "Holding 2", … */
  async nextHoldingName(userId: string, db: Db = this.db) {
    const taken = new Set(
      (await db.query<{ name: string }>(`SELECT name FROM eh_portfolios WHERE user_id=$1 AND deleted_at IS NULL`, [userId])).map((r) => r.name.toLowerCase()),
    );
    let i = 1;
    while (taken.has(`holding ${i}`)) i++;
    return `Holding ${i}`;
  }

  async uniqueName(userId: string, wanted: string, exceptId?: string, db: Db = this.db) {
    const base = wanted.trim().replace(/\s+/g, ' ').slice(0, 40);
    if (base.length < 2) throw new HttpError(400, 'invalid_name', 'Enter a name with at least 2 characters');
    const taken = new Set(
      (await db.query<{ name: string; id: string }>(`SELECT id, name FROM eh_portfolios WHERE user_id=$1 AND deleted_at IS NULL`, [userId]))
        .filter((r) => r.id !== exceptId)
        .map((r) => r.name.toLowerCase()),
    );
    let n = base;
    for (let i = 2; taken.has(n.toLowerCase()); i++) n = `${base.slice(0, 36)} ${i}`;
    return n;
  }

  async rename(userId: string, id: string, name: string) {
    await this.ownPortfolio(userId, id);
    const n = await this.uniqueName(userId, name, id);
    await this.db.query(`UPDATE eh_portfolios SET name=$1, updated_at=now() WHERE id=$2`, [n, id]);
    return { id, name: n };
  }

  async remove(userId: string, id: string) {
    await this.ownPortfolio(userId, id);
    await this.db.tx(async (t) => {
      const hs = await t.query<{ id: string }>(`SELECT id FROM eh_holdings WHERE portfolio_id=$1`, [id]);
      await t.query(`DELETE FROM eh_payout_receipts WHERE user_id=$1 AND holding_id = ANY($2)`, [userId, hs.map((h) => h.id)]);
      await t.query(`DELETE FROM eh_holdings WHERE portfolio_id=$1`, [id]);
      await t.query(`UPDATE eh_portfolios SET deleted_at=now() WHERE id=$1`, [id]);
      // Stop reminders that were only about this portfolio's payouts.
      const ids = new Set(hs.map((h) => h.id));
      const pending = await t.query<{ id: string; payload: { eventKeys?: string[] } }>(
        `SELECT id, payload FROM eh_notification_outbox WHERE user_id=$1 AND status='pending'`,
        [userId],
      );
      const dead = pending.filter((o) => (o.payload.eventKeys ?? []).length && o.payload.eventKeys!.every((k) => ids.has(k.split('|')[0]))).map((o) => o.id);
      if (dead.length) await t.query(`UPDATE eh_notification_outbox SET status='skipped', last_error='portfolio deleted' WHERE id = ANY($1)`, [dead]);
    });
  }

  async setUnits(userId: string, portfolioId: string, isin: string, units: number) {
    await this.ownPortfolio(userId, portfolioId);
    if (!(units > 0)) throw new HttpError(400, 'invalid_units', 'Units must be a whole number greater than 0.');
    const r = await this.db.query(`UPDATE eh_holdings SET units=$1, updated_at=now() WHERE portfolio_id=$2 AND isin=$3 RETURNING id`, [units, portfolioId, isin]);
    if (!r.length) throw new HttpError(404, 'holding_not_found', 'Holding not found');
  }

  /** "Add details" for a bond still awaiting data (from the reminder or the External page). */
  async addDetails(userId: string, holdingId: string, terms: CustomTerms, today: string) {
    const e = validateCustomTerms(terms, today);
    if (e) throw new HttpError(400, 'invalid_details', e);
    const r = await this.db.query(
      `UPDATE eh_holdings h SET custom_terms=$1, awaiting=false, notified_at=NULL, updated_at=now()
         FROM eh_portfolios p
        WHERE h.id=$2 AND p.id=h.portfolio_id AND p.user_id=$3 AND p.deleted_at IS NULL
        RETURNING h.id`,
      [JSON.stringify(terms), holdingId, userId],
    );
    if (!r.length) throw new HttpError(404, 'holding_not_found', 'Holding not found');
  }

  /** Investment entry for a holding (date, units, invested amount, yield), from "Add details". */
  async setInvestment(userId: string, holdingId: string, v: { units: number; acquiredOn: string; investedAmount: number; purchaseYield: number; issuerName?: string }, today: string) {
    if (!(v.units > 0)) throw new HttpError(400, 'invalid_units', 'Units must be a whole number greater than 0.');
    if (v.acquiredOn > today) throw new HttpError(400, 'invalid_date', 'Date of investment cannot be a future date.');
    const r = await this.db.query(
      `UPDATE eh_holdings h SET units=$1, acquired_on=$2, invested_amount=$3, purchase_yield=$4, issuer_name=COALESCE($7, h.issuer_name), details_requested_at=NULL, updated_at=now()
         FROM eh_portfolios p
        WHERE h.id=$5 AND p.id=h.portfolio_id AND p.user_id=$6 AND p.deleted_at IS NULL
        RETURNING h.id`,
      [v.units, v.acquiredOn, v.investedAmount, v.purchaseYield, holdingId, userId, v.issuerName?.trim() || null],
    );
    if (!r.length) throw new HttpError(404, 'holding_not_found', 'Holding not found');
  }

  async removeHolding(userId: string, portfolioId: string, isin: string) {
    await this.ownPortfolio(userId, portfolioId);
    const r = await this.db.query<{ id: string }>(`SELECT id FROM eh_holdings WHERE portfolio_id=$1 AND isin=$2`, [portfolioId, isin]);
    if (!r.length) throw new HttpError(404, 'holding_not_found', 'Holding not found');
    return this.removeHoldingById(userId, r[0].id);
  }

  /**
   * Removes one bond. Its received marks go with it, and the files it came from are forgotten,
   * so uploading the same file again reads it instead of skipping it as "already added".
   * A holding left with no bonds is deleted.
   */
  async removeHoldingById(userId: string, holdingId: string) {
    return this.db.tx(async (t) => {
      const r = await t.query<{ id: string; portfolio_id: string }>(
        `SELECT h.id, h.portfolio_id FROM eh_holdings h JOIN eh_portfolios p ON p.id = h.portfolio_id
          WHERE h.id=$1 AND p.user_id=$2 AND p.deleted_at IS NULL`,
        [holdingId, userId],
      );
      if (!r.length) throw new HttpError(404, 'holding_not_found', 'Holding not found');
      const pid = r[0].portfolio_id;
      await t.query(`DELETE FROM eh_payout_receipts WHERE user_id=$1 AND holding_id=$2`, [userId, holdingId]);
      await t.query(`DELETE FROM eh_holdings WHERE id=$1`, [holdingId]);
      await t.query(`UPDATE eh_imports SET file_hashes='{}' WHERE user_id=$1 AND committed_portfolio_id=$2`, [userId, pid]);
      const left = await t.query(`SELECT 1 FROM eh_holdings WHERE portfolio_id=$1 LIMIT 1`, [pid]);
      if (!left.length) await t.query(`UPDATE eh_portfolios SET deleted_at=now() WHERE id=$1`, [pid]);
      else await t.query(`UPDATE eh_portfolios SET updated_at=now() WHERE id=$1`, [pid]);
      return { portfolioDeleted: !left.length };
    });
  }

  // ---------- duplicates and commit ----------
  async matchAgainstSaved(userId: string, rows: { isin: string; units: number }[], replaceId?: string, statementDate?: string | null, statementPan?: string | null, statementOwner?: 'self' | 'other' | 'unknown') {
    const { ps, hs } = await this.portfolios(userId);
    const candidates = ps
      .filter((p) => !replaceId || p.id === replaceId)
      // A statement for a different person is never an "update" of another person's holding:
      // someone else's statement only matches family holdings, and only with the same masked PAN.
      .filter((p) => (statementOwner === 'other' ? p.owner_type === 'family' : p.owner_type !== 'family' || statementOwner !== 'self'))
      .filter((p) => !statementPan || !p.owner_pan_masked || p.owner_pan_masked === statementPan)
      .map((p) => ({ id: p.id, name: p.name, rows: hs.filter((h) => h.portfolio_id === p.id).map((h) => ({ isin: h.isin, units: Number(h.units) })) }));
    let match = findMatch(rows, candidates);
    if (replaceId && !match && candidates[0]) {
      const shared = rows.filter((r) => candidates[0].rows.some((x) => x.isin === r.isin)).length;
      match = { portfolioId: replaceId, portfolioName: candidates[0].name, type: 'update', coverage: 0, shared };
    }
    if (!match) return null;
    const existing = candidates.find((c) => c.id === match!.portfolioId)!;
    const diff = diffRows(existing.rows, rows);
    const terms = await this.bonds.getMany([...diff.removed, ...diff.added, ...diff.changed.map((c) => c.isin)]);
    const names: Record<string, string> = {};
    for (const [k, v] of terms) names[k] = v.name;
    const saved = ps.find((p) => p.id === match!.portfolioId)?.statement_date;
    const savedDate = saved ? isoDate(saved) : null;
    return { ...match, diff, names, savedStatementDate: savedDate, olderThanSaved: !!(savedDate && statementDate && statementDate < savedDate) };
  }

  async alreadyIn(userId: string, isins: string[]) {
    if (!isins.length) return new Map<string, { portfolioId: string; name: string; units: number }[]>();
    const rows = await this.db.query<{ isin: string; portfolio_id: string; name: string; units: number }>(
      `SELECT h.isin, h.portfolio_id, p.name, h.units FROM eh_holdings h JOIN eh_portfolios p ON p.id = h.portfolio_id
        WHERE p.user_id=$1 AND p.deleted_at IS NULL AND h.isin = ANY($2)`,
      [userId, isins],
    );
    const m = new Map<string, { portfolioId: string; name: string; units: number }[]>();
    for (const r of rows) m.set(r.isin, [...(m.get(r.isin) ?? []), { portfolioId: r.portfolio_id, name: r.name, units: Number(r.units) }]);
    return m;
  }

  /**
   * Save reviewed rows.
   *  - new:          a new external portfolio (auto-named "My holdings", "My holdings 2", ...).
   *  - replace:      newer statement for an existing portfolio. Bonds missing from it are kept
   *                  unless the user marked them sold (edge case: never auto-mark as sold).
   *  - add_new_only: partial overlap; only bonds not already in that portfolio are added.
   *  - append:       holdings template upload into the user's holding (created if there is none). Every row is
   *                  added as its own row; saved rows with the same ISIN and date as one in replaceLots are removed first.
   */
  async commit(
    userId: string,
    input: {
      rows: { isin: string; units: number; investedAmount?: number; acquiredOn?: ISODate; purchaseYield?: number; issuerName?: string; customTerms?: CustomTerms; notify?: boolean }[];
      mode: 'new' | 'replace' | 'add_new_only' | 'append';
      name?: string;
      portfolioId?: string;
      soldIsins?: string[];
      /** append: save into a new holding ("My holdings 2", …) instead of an existing one. */
      newHolding?: boolean;
      /** append: saved rows (same ISIN and date of investment) replaced by this upload's rows. */
      replaceLots?: { isin: string; acquiredOn: ISODate }[];
      statementDate?: string | null;
      /** Resolved ownership: 'family' for someone else's statement (user confirmed permission). */
      owner?: { kind: 'self' | 'family'; label?: string; panMasked?: string | null; holder?: string | null };
    },
    today: ISODate = todayIST(),
  ) {
    if (!input.rows.length) throw new HttpError(400, 'no_rows', 'Please add at least one bond.');
    const isins = input.rows.map((r) => r.isin);
    // One row per bond per date of investment: the same bond bought on different dates is kept as separate rows.
    const lotOf = (isin: string, on?: string | null) => `${isin}|${on ?? ''}`;
    const lots = input.rows.map((r) => lotOf(r.isin, r.acquiredOn));
    if (new Set(lots).size !== lots.length) throw new HttpError(400, 'duplicate_isin', 'Each bond can be added only once for a date of investment.');
    if (input.rows.some((r) => !(r.units > 0))) throw new HttpError(400, 'invalid_units', 'Units must be more than 0');
    const terms = await this.bonds.getMany(input.rows.map((r) => r.isin));
    const unknown = input.rows.filter((r) => !r.customTerms && !r.notify && !terms.has(r.isin)).map((r) => r.isin);
    if (unknown.length) throw new HttpError(422, 'unknown_isin', `Add details, tap Notify me, or remove: ${unknown.join(', ')}`);

    type Row = (typeof input.rows)[number];
    const awaitingOf = (r: Row) => !!r.notify && !terms.has(r.isin) && !r.customTerms;
    /** A new row, always. */
    const add = (t: Db, pid: string, r: Row) =>
      t.query(
        `INSERT INTO eh_holdings (id, portfolio_id, isin, units, invested_amount, acquired_on, tracked_from, custom_terms, awaiting, notify_requested_at, purchase_yield, issuer_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [randomUUID(), pid, r.isin, r.units, r.investedAmount ?? null, r.acquiredOn ?? null, today, r.customTerms ? JSON.stringify(r.customTerms) : null, awaitingOf(r), r.notify ? new Date().toISOString() : null, r.purchaseYield ?? null, r.issuerName?.trim() || null],
      );
    /** Statement flows: update the saved row for the same bond and date (keeps tracked_from and received marks), else add. */
    const insert = async (t: Db, pid: string, r: Row) => {
      const ex = await t.query<{ id: string }>(
        `SELECT id FROM eh_holdings WHERE portfolio_id=$1 AND isin=$2 AND acquired_on IS NOT DISTINCT FROM $3::date ORDER BY created_at LIMIT 1`,
        [pid, r.isin, r.acquiredOn ?? null],
      );
      if (!ex.length) return add(t, pid, r);
      await t.query(
        `UPDATE eh_holdings SET units=$2, purchase_yield=COALESCE($3, purchase_yield), invested_amount=COALESCE($4, invested_amount),
           custom_terms=COALESCE($5, custom_terms), awaiting=$6, issuer_name=COALESCE($7, issuer_name), updated_at=now() WHERE id=$1`,
        [ex[0].id, r.units, r.purchaseYield ?? null, r.investedAmount ?? null, r.customTerms ? JSON.stringify(r.customTerms) : null, awaitingOf(r), r.issuerName?.trim() || null],
      );
    };

    return this.db.tx(async (t) => {
      let pid: string;
      let name: string;
      let added = 0;
      let sold = 0;
      if (input.mode === 'append') {
        // The user's holding: the one given, else the first one, else a new "My holdings".
        const own = await t.query<{ id: string; name: string }>(
          `SELECT id, name FROM eh_portfolios WHERE user_id=$1 AND deleted_at IS NULL ORDER BY created_at LIMIT 1`,
          [userId],
        );
        if (input.newHolding) {
          pid = randomUUID();
          name = input.name?.trim() ? await this.uniqueName(userId, input.name, undefined, t) : await this.nextHoldingName(userId, t);
          await t.query(`INSERT INTO eh_portfolios (id, user_id, name, owner_type) VALUES ($1,$2,$3,'self')`, [pid, userId, name]);
        } else if (input.portfolioId) {
          const p = await this.ownPortfolio(userId, input.portfolioId, t);
          pid = p.id;
          name = p.name;
        } else if (own.length) {
          pid = own[0].id;
          name = own[0].name;
        } else {
          pid = randomUUID();
          name = input.name?.trim() ? await this.uniqueName(userId, input.name, undefined, t) : await this.nextHoldingName(userId, t);
          await t.query(`INSERT INTO eh_portfolios (id, user_id, name, owner_type) VALUES ($1,$2,$3,'self')`, [pid, userId, name]);
        }
        const replace = (input.replaceLots ?? []).filter((l) => lots.includes(lotOf(l.isin, l.acquiredOn)));
        if (replace.length) {
          const old: { id: string }[] = [];
          for (const l of replace)
            old.push(...(await t.query<{ id: string }>(`SELECT id FROM eh_holdings WHERE portfolio_id=$1 AND isin=$2 AND acquired_on=$3::date`, [pid, l.isin, l.acquiredOn])));
          if (old.length) {
            await t.query(`DELETE FROM eh_holdings WHERE id = ANY($1)`, [old.map((h) => h.id)]);
            await t.query(`DELETE FROM eh_payout_receipts WHERE user_id=$1 AND holding_id = ANY($2)`, [userId, old.map((h) => h.id)]);
          }
        }
        for (const r of input.rows) await add(t, pid, r);
        added = input.rows.length;
        await t.query(`UPDATE eh_portfolios SET updated_at=now() WHERE id=$1`, [pid]);
      } else if (input.mode === 'new') {
        pid = randomUUID();
        const fam = input.owner?.kind === 'family';
        const label = input.owner?.label?.trim() || null;
        name = await this.uniqueName(userId, input.name?.trim() || (fam ? `${label ?? 'Family'}’s holdings` : 'My holdings'), undefined, t);
        await t.query(
          `INSERT INTO eh_portfolios (id, user_id, name, statement_date, owner_type, owner_label, owner_pan_masked) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [pid, userId, name, input.statementDate ?? null, fam ? 'family' : 'self', fam ? label : null, input.owner?.panMasked ?? null],
        );
        for (const r of input.rows) await insert(t, pid, r);
        added = input.rows.length;
      } else {
        if (!input.portfolioId) throw new HttpError(400, 'portfolio_required', 'portfolioId is required');
        const p = await this.ownPortfolio(userId, input.portfolioId, t);
        pid = p.id;
        name = p.name;
        const existing = await t.query<HoldingRow>(`SELECT * FROM eh_holdings WHERE portfolio_id=$1`, [pid]);
        const have = new Set(existing.map((h) => h.isin));
        const haveLots = new Set(existing.map((h) => lotOf(h.isin, h.acquired_on ? isoDate(h.acquired_on) : null)));
        if (input.mode === 'add_new_only') {
          for (const r of input.rows.filter((r) => !have.has(r.isin))) {
            await insert(t, pid, r);
            added++;
          }
        } else {
          const soldSet = new Set((input.soldIsins ?? []).filter((i) => have.has(i) && !isins.includes(i)));
          // A bond in the new list replaces its saved rows: purchases (dates) no longer listed for it are removed.
          const keep = new Set(lots);
          const soldRows = existing.filter((h) => soldSet.has(h.isin) || (isins.includes(h.isin) && !keep.has(lotOf(h.isin, h.acquired_on ? isoDate(h.acquired_on) : null))));
          if (soldRows.length) {
            await t.query(`DELETE FROM eh_holdings WHERE id = ANY($1)`, [soldRows.map((h) => h.id)]);
            await t.query(`DELETE FROM eh_payout_receipts WHERE user_id=$1 AND holding_id = ANY($2)`, [userId, soldRows.map((h) => h.id)]);
          }
          sold = soldRows.filter((h) => soldSet.has(h.isin)).length;
          // Upsert keeps tracked_from for bonds already tracked, so "received" marks survive.
          for (const r of input.rows) {
            if (!haveLots.has(lotOf(r.isin, r.acquiredOn))) added++;
            await insert(t, pid, r);
          }
          const older = p.statement_date && input.statementDate && input.statementDate < isoDate(p.statement_date);
          if (input.statementDate && !older) await t.query(`UPDATE eh_portfolios SET statement_date=$1 WHERE id=$2`, [input.statementDate, pid]);
        }
        await t.query(`UPDATE eh_portfolios SET updated_at=now() WHERE id=$1`, [pid]);
      }
      if (input.owner)
        await t.query(
          `INSERT INTO eh_ownership_confirmations (id, user_id, portfolio_id, kind, owner_label, pan_masked, holder_name) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [randomUUID(), userId, pid, input.owner.kind, input.owner.label ?? null, input.owner.panMasked ?? null, input.owner.holder ?? null],
        );
      return { portfolioId: pid, name, added, sold };
    });
  }

  // ---------- notification preferences ----------
  async prefs(userId: string): Promise<NotificationPrefs> {
    const r = await this.db.query<Record<string, boolean>>(`SELECT * FROM eh_notification_prefs WHERE user_id=$1`, [userId]);
    if (!r.length) return DEFAULT_PREFS;
    const x = r[0];
    return { push: x.push, email: x.email, whatsapp: x.whatsapp, dayBefore: x.day_before, sameDay: x.same_day, confirmNudge: x.confirm_nudge, maturityHeadsUp: x.maturity_heads_up };
  }

  async setPrefs(userId: string, p: NotificationPrefs) {
    await this.db.query(
      `INSERT INTO eh_notification_prefs (user_id, push, email, whatsapp, day_before, same_day, confirm_nudge, maturity_heads_up, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
       ON CONFLICT (user_id) DO UPDATE SET push=EXCLUDED.push, email=EXCLUDED.email, whatsapp=EXCLUDED.whatsapp,
         day_before=EXCLUDED.day_before, same_day=EXCLUDED.same_day, confirm_nudge=EXCLUDED.confirm_nudge,
         maturity_heads_up=EXCLUDED.maturity_heads_up, updated_at=now()`,
      [userId, p.push, p.email, p.whatsapp, p.dayBefore, p.sameDay, p.confirmNudge, p.maturityHeadsUp],
    );
  }

  // ---------- who is using the tool ----------
  /** The visitor's name and email, or null before they have given them. Counts as a visit (logged at most every 30 min). */
  async profile(userId: string): Promise<{ name: string; email: string } | null> {
    const r = await this.db.query<{ name: string; email: string; last_seen_at: string | Date }>(`SELECT name, email, last_seen_at FROM eh_users WHERE user_id=$1`, [userId]);
    if (!r.length) {
      // Anonymous visitor (no name known): log the visit at most every 30 minutes.
      const recent = await this.db.query(`SELECT 1 FROM eh_events WHERE user_id=$1 AND name='eh_visit' AND created_at > now() - interval '30 minutes' LIMIT 1`, [userId]);
      if (!recent.length) await this.track(userId, 'eh_visit');
      return null;
    }
    const last = new Date(r[0].last_seen_at).getTime();
    await this.db.query(`UPDATE eh_users SET last_seen_at=now() WHERE user_id=$1`, [userId]);
    if (!(Date.now() - last < 30 * 60_000)) await this.track(userId, 'eh_visit');
    return { name: r[0].name, email: r[0].email };
  }

  async setProfile(userId: string, v: { name: string; email: string }) {
    const r = await this.db.query<{ created: boolean }>(
      `INSERT INTO eh_users (user_id, name, email) VALUES ($1,$2,$3)
       ON CONFLICT (user_id) DO UPDATE SET name=EXCLUDED.name, email=EXCLUDED.email, last_seen_at=now()
       RETURNING (xmax = 0) AS created`,
      [userId, v.name, v.email],
    );
    await this.track(userId, r[0]?.created ? 'eh_signed_up' : 'eh_profile_updated');
    return { name: v.name, email: v.email };
  }

  // ---------- "Send us your holdings in any format" ----------
  async addAssisted(userId: string, f: { fileName: string; mime: string; data: Uint8Array; note?: string }) {
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO eh_assisted_uploads (id, user_id, file_name, mime, size, data, note) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, userId, f.fileName.slice(0, 200), f.mime.slice(0, 100), f.data.byteLength, Buffer.from(f.data), f.note?.trim().slice(0, 500) || null],
    );
    await this.track(userId, 'eh_assisted_sent', { size: f.data.byteLength });
    return { id };
  }

  /** "Name (email)" when known (gateway inside bondscanner.com), else null. */
  async userLabel(userId: string): Promise<string | null> {
    const r = await this.db.query<{ name: string; email: string }>(`SELECT name, email FROM eh_users WHERE user_id=$1`, [userId]);
    return r.length ? `${r[0].name} (${r[0].email})` : null;
  }

  /** The visitor's own requests (no file contents): shown on the holdings page until a week after they are done. */
  async myAssisted(userId: string) {
    return this.db.query<{ id: string; fileName: string; status: string; createdAt: string; doneAt: string | null }>(
      `SELECT id, file_name AS "fileName", status, to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "createdAt",
              to_char(done_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "doneAt"
         FROM eh_assisted_uploads
        WHERE user_id=$1 AND (status='received' OR done_at > now() - interval '7 days')
        ORDER BY created_at DESC LIMIT 5`,
      [userId],
    );
  }

  async adminAssisted() {
    return this.db.query<Record<string, unknown>>(
      `SELECT a.id, a.user_id AS "userId", u.name, u.email, a.file_name AS "fileName", a.mime, a.size, a.note, a.status,
              (a.data IS NOT NULL) AS "hasFile", a.rows_added AS "rowsAdded",
              to_char(a.created_at + interval '5 hours 30 minutes', 'YYYY-MM-DD"T"HH24:MI') AS "createdAt",
              to_char(a.done_at + interval '5 hours 30 minutes', 'YYYY-MM-DD"T"HH24:MI') AS "doneAt"
         FROM eh_assisted_uploads a LEFT JOIN eh_users u ON u.user_id = a.user_id
        ORDER BY (a.status = 'received') DESC, a.created_at DESC LIMIT 200`,
    );
  }

  async adminAssistedFile(id: string) {
    const r = await this.db.query<{ file_name: string; mime: string; data: Uint8Array | null }>(`SELECT file_name, mime, data FROM eh_assisted_uploads WHERE id=$1`, [id]);
    if (!r.length) throw new HttpError(404, 'not_found', 'File not found');
    if (!r[0].data) throw new HttpError(410, 'file_deleted', 'This file was deleted');
    return { ...r[0], data: r[0].data };
  }

  /** Delete the stored file to free space; the request (name, dates, status) stays. */
  async adminAssistedDeleteFile(id: string) {
    const r = await this.db.query<{ user_id: string }>(
      `UPDATE eh_assisted_uploads SET data = NULL, file_deleted_at = now() WHERE id=$1 RETURNING user_id`,
      [id],
    );
    if (!r.length) throw new HttpError(404, 'not_found', 'Request not found');
  }

  /** The visitor a request belongs to. */
  async assistedUser(id: string) {
    const r = await this.db.query<{ user_id: string }>(`SELECT user_id FROM eh_assisted_uploads WHERE id=$1`, [id]);
    if (!r.length) throw new HttpError(404, 'not_found', 'Request not found');
    return r[0].user_id;
  }

  /** After the team added the visitor's holdings: mark the request done with the number of bonds added. */
  async adminAssistedAdded(id: string, rows: number) {
    await this.db.query(`UPDATE eh_assisted_uploads SET status='done', done_at=now(), rows_added=COALESCE(rows_added, 0) + $2 WHERE id=$1`, [id, rows]);
  }

  async adminAssistedDone(id: string, done: boolean) {
    const r = await this.db.query<{ user_id: string }>(
      `UPDATE eh_assisted_uploads SET status=$2, done_at=CASE WHEN $2='done' THEN now() ELSE NULL END WHERE id=$1 RETURNING user_id`,
      [id, done ? 'done' : 'received'],
    );
    if (!r.length) throw new HttpError(404, 'not_found', 'Request not found');
    if (done) await this.track(r[0].user_id, 'eh_assisted_done');
  }

  /** Feature adoption for the admin page: headline numbers, funnel, per-day usage, people, recent activity. */
  async adminStats(days = 30) {
    const one = async <T>(sql: string, p: unknown[] = []) => (await this.db.query<T>(sql, p))[0];
    // Everyone who has used the tool: anyone with an event or a saved holding. No login, so most are anonymous.
    const everyone = `SELECT user_id FROM eh_events UNION SELECT user_id FROM eh_portfolios`;
    // People who have a holding with at least one bond right now.
    const holdingUsers = `SELECT DISTINCT p.user_id FROM eh_portfolios p JOIN eh_holdings h ON h.portfolio_id = p.id WHERE p.deleted_at IS NULL`;
    const ever = (cond: string) => `SELECT count(DISTINCT user_id)::int AS n FROM eh_events WHERE ${cond}`;
    const totals = await one<{ signed_up: number; visitors: number; active_7d: number; with_holdings: number; isins: number; rows: number; invested: number }>(
      `SELECT
         (SELECT count(*)::int FROM eh_users) AS signed_up,
         (SELECT count(*)::int FROM (${everyone}) x) AS visitors,
         (SELECT count(DISTINCT user_id)::int FROM eh_events WHERE created_at > now() - interval '7 days') AS active_7d,
         (SELECT count(*)::int FROM (${holdingUsers}) x) AS with_holdings,
         (SELECT count(DISTINCT h.isin)::int FROM eh_holdings h JOIN eh_portfolios p ON p.id = h.portfolio_id WHERE p.deleted_at IS NULL) AS isins,
         (SELECT count(*)::int FROM eh_holdings h JOIN eh_portfolios p ON p.id = h.portfolio_id WHERE p.deleted_at IS NULL) AS rows,
         (SELECT coalesce(sum(h.invested_amount), 0)::float FROM eh_holdings h JOIN eh_portfolios p ON p.id = h.portfolio_id WHERE p.deleted_at IS NULL) AS invested`,
    );
    const step = async (label: string, sql: string) => ({ label, users: (await one<{ n: number }>(sql)).n });
    const funnel = [
      await step('Visited', `SELECT count(*)::int AS n FROM (${everyone}) x`),
      await step('Opened the upload page', ever(`name = 'eh_add_opened'`)),
      await step('Downloaded the template', ever(`name = 'eh_template_downloaded'`)),
      await step('Uploaded a file', ever(`name IN ('eh_template_uploaded', 'eh_import_parsed', 'eh_assisted_sent')`)),
      await step('Saved holdings', ever(`name LIKE 'eh_portfolio_%' AND name <> 'eh_portfolio_deleted'`)),
      await step('Still has holdings', `SELECT count(*)::int AS n FROM (${holdingUsers}) x`),
    ];
    const daily = await this.db.query<{ day: string; active: number; sign_ups: number; saves: number }>(
      `SELECT to_char((created_at + interval '5 hours 30 minutes')::date, 'YYYY-MM-DD') AS day,
              count(DISTINCT user_id)::int AS active,
              (count(*) FILTER (WHERE name = 'eh_signed_up'))::int AS sign_ups,
              (count(*) FILTER (WHERE name LIKE 'eh_portfolio_%' AND name <> 'eh_portfolio_deleted'))::int AS saves
         FROM eh_events
        WHERE created_at > now() - make_interval(days => $1)
        GROUP BY 1 ORDER BY 1`,
      [days],
    );
    const users = await this.db.query<Record<string, unknown>>(
      `WITH people AS (${everyone}),
            ev AS (SELECT user_id, min(created_at) AS first_at, max(created_at) AS last_at,
                          count(*) FILTER (WHERE name = 'eh_visit') AS visits,
                          count(*) FILTER (WHERE name LIKE 'eh_portfolio_%' AND name <> 'eh_portfolio_deleted') AS uploads
                     FROM eh_events GROUP BY user_id),
            hold AS (SELECT p.user_id, count(DISTINCT h.isin) AS isins, coalesce(sum(h.invested_amount), 0) AS invested, min(p.created_at) AS first_at
                       FROM eh_portfolios p JOIN eh_holdings h ON h.portfolio_id = p.id WHERE p.deleted_at IS NULL GROUP BY p.user_id)
       SELECT pe.user_id AS id, u.name, u.email,
              to_char(least(ev.first_at, hold.first_at) + interval '5 hours 30 minutes', 'YYYY-MM-DD"T"HH24:MI') AS signed_up,
              to_char(coalesce(greatest(ev.last_at, u.last_seen_at), ev.last_at, u.last_seen_at, hold.first_at) + interval '5 hours 30 minutes', 'YYYY-MM-DD"T"HH24:MI') AS last_seen,
              coalesce(hold.isins, 0)::int AS isins, coalesce(hold.invested, 0)::float AS invested,
              coalesce(ev.uploads, 0)::int AS uploads, coalesce(ev.visits, 0)::int AS visits
         FROM people pe
         LEFT JOIN eh_users u ON u.user_id = pe.user_id
         LEFT JOIN ev ON ev.user_id = pe.user_id
         LEFT JOIN hold ON hold.user_id = pe.user_id
        ORDER BY coalesce(ev.last_at, hold.first_at) DESC NULLS LAST
        LIMIT 500`,
    );
    const recent = await this.db.query<Record<string, unknown>>(
      `SELECT to_char(at_ist, 'YYYY-MM-DD"T"HH24:MI') AS at, name, coalesce(email, '') AS email, event, props, user_id AS id
         FROM eh_admin.activity LIMIT 60`,
    );
    const clicks = await this.db.query<{ target: string; clicks: number; people: number }>(
      `SELECT props->>'target' AS target, count(*)::int AS clicks, count(DISTINCT user_id)::int AS people
         FROM eh_events WHERE name = 'eh_click' AND created_at > now() - make_interval(days => $1)
        GROUP BY 1 ORDER BY 2 DESC`,
      [days],
    );
    return { days, totals, funnel, daily, users, recent, clicks };
  }

  async track(userId: string, name: string, props: Record<string, unknown> = {}) {
    await this.db.query(`INSERT INTO eh_events (user_id, name, props) VALUES ($1,$2,$3)`, [userId, name, JSON.stringify(props)]).catch(() => undefined);
  }
}
