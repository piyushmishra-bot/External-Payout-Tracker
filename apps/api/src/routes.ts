import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sendAssistedAlert } from './notify/alerts';
import { z } from 'zod';
import { financialYear, formatDateNumeric, inr, ISSUER_NAME_MAX, todayIST, validateCustomTerms } from '@eh/core';
import { config, isEnabledFor } from './config';
import type { Container } from './container';
import { HttpError } from './services/holdings';
import { ImportService, MAX_FILES } from './services/imports';
import { parseDirectoryFile } from './services/directory';
import { fetchBondScannerBonds } from './providers/bondscannerSite';
import { timingSafeEqual } from 'node:crypto';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
// "Add manually" / "Add details": used until Deridata data arrives. No upper limits (product decision).
const customTerms = z.object({
  couponRate: z.number().positive(),
  maturityDate: isoDate,
  frequency: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(12)]),
  faceValue: z.number().positive(),
  name: z.string().max(80).optional(),
});
const draftRow = z.object({
  key: z.string().max(40),
  isin: z.string().max(20).optional(),
  units: z.number().nonnegative().optional(),
  investedAmount: z.number().positive().optional(),
  acquiredOn: isoDate.optional(),
  purchaseYield: z.number().min(0).max(100).optional(),
  nameHint: z.string().max(120).optional(),
  confidence: z.enum(['high', 'low']).default('high'),
  customTerms: customTerms.optional(),
  notify: z.boolean().optional(),
  ok: z.boolean().optional(),
  files: z.array(z.string()).optional(),
});
const commitRow = z.object({
  isin: z.string().length(12),
  units: z.number().positive(),
  investedAmount: z.number().positive().optional(),
  acquiredOn: isoDate.optional(),
  purchaseYield: z.number().min(0).max(100).optional(),
  issuerName: z.string().max(ISSUER_NAME_MAX).optional(),
  customTerms: customTerms.optional(),
  notify: z.boolean().optional(),
});
const prefsSchema = z.object({
  push: z.boolean(), email: z.boolean(), whatsapp: z.boolean(), dayBefore: z.boolean(),
  sameDay: z.boolean(), confirmNudge: z.boolean(), maturityHeadsUp: z.boolean(),
});

function userOf(req: FastifyRequest): string {
  if (config.gatewaySecret && req.headers['x-gateway-secret'] !== config.gatewaySecret)
    throw new HttpError(401, 'unauthenticated', 'Please log in to continue.');
  const id = req.headers[config.userIdHeader];
  if (typeof id !== 'string' || !id.trim()) throw new HttpError(401, 'unauthenticated', 'Please log in to continue.');
  if (!isEnabledFor(id)) throw new HttpError(404, 'not_enabled', 'This feature is not available yet.');
  return id;
}

/** Lets QA and the demo pretend it is another day. Ignored in production. */
function todayOf(req: FastifyRequest): string {
  const h = req.headers['x-eh-today'];
  if (process.env.NODE_ENV !== 'production' && typeof h === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(h)) return h;
  return todayIST();
}

export async function registerRoutes(app: FastifyInstance, c: Container) {
  const P = '/v1/external-holdings';

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code, message: err.message });
    if (err instanceof z.ZodError) return reply.status(400).send({ error: 'invalid_request', message: 'Some details are missing or invalid', issues: err.issues });
    if (err.statusCode === 413 || err.code === 'FST_REQ_FILE_TOO_LARGE')
      return reply.status(413).send({ error: 'file_too_large', message: `Files up to ${config.maxUploadBytes / 1048576} MB` });
    // Fastify's own request errors (bad JSON, unsupported content type, …) are the caller's mistake, not a server failure.
    if (typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500)
      return reply.status(err.statusCode).send({ error: 'bad_request', message: err.message });
    app.log.error(err);
    if (process.env.NODE_ENV === 'test') console.error(err);
    return reply.status(500).send({ error: 'internal', message: 'Something went wrong. Please try again.' });
  });

  app.get('/healthz', async () => ({ ok: true }));

  app.get(`${P}/status`, async (req) => {
    const u = userOf(req);
    const consented = await c.holdings.hasConsent(u, config.consentVersion);
    const { ps } = await c.holdings.portfolios(u);
    return { enabled: true, consented, consentVersion: config.consentVersion, externalPortfolios: ps.length };
  });

  app.post(`${P}/consent`, async (req) => {
    const u = userOf(req);
    await c.holdings.giveConsent(u, config.consentVersion, req.ip, String(req.headers['user-agent'] ?? ''));
    await c.holdings.track(u, 'eh_consent_given', { version: config.consentVersion });
    return { ok: true };
  });

  app.get(`${P}/overview`, async (req) => {
    const u = userOf(req);
    const q = z.object({ scope: z.string().default('all') }).parse(req.query);
    return c.holdings.overview(u, q.scope, todayOf(req));
  });

  app.get(`${P}/payouts`, async (req) => {
    const u = userOf(req);
    const q = z.object({ scope: z.string().default('all'), from: isoDate.optional(), to: isoDate.optional() }).parse(req.query);
    return { today: todayOf(req), payouts: await c.holdings.payouts(u, { ...q, today: todayOf(req) }) };
  });

  app.post(`${P}/payouts/received`, async (req) => {
    const u = userOf(req);
    const b = z.object({ holdingId: z.string(), scheduledDate: isoDate, received: z.boolean() }).parse(req.body);
    await c.holdings.setReceived(u, b.holdingId, b.scheduledDate, b.received);
    await c.holdings.track(u, b.received ? 'eh_payout_marked_received' : 'eh_payout_unmarked');
    return { ok: true };
  });

  app.get(`${P}/report`, async (req) => {
    const u = userOf(req);
    const q = z.object({ scope: z.string().default('all') }).parse(req.query);
    return c.holdings.report(u, q.scope);
  });

  app.get(`${P}/tax-statement`, async (req, reply) => {
    const u = userOf(req);
    const q = z.object({ fy: z.string().regex(/^\d{4}-\d{2}$/).default(financialYear(todayOf(req))), format: z.enum(['json', 'csv']).default('json') }).parse(req.query);
    const st = await c.holdings.taxStatement(u, q.fy);
    await c.holdings.track(u, 'eh_tax_statement', { fy: q.fy, format: q.format });
    if (q.format === 'json') return st;
    const esc = (s: unknown) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const lines = [
      ['Date', 'Bond', 'ISIN', 'Portfolio', 'Gross interest (INR)', 'Indicative TDS 10% (INR)', 'Marked received'].map(esc).join(','),
      ...st.rows.map((r) => [r.date, r.bondName, r.isin, r.portfolioName, r.grossInterest.toFixed(2), r.indicativeTds.toFixed(2), r.received ? 'Yes' : 'No'].map(esc).join(',')),
      '',
      [esc('Total'), '', '', '', esc(st.totalInterest.toFixed(2)), esc(st.totalTds.toFixed(2)), ''].join(','),
      esc(`Interest expected in FY ${st.fy} from the holdings you track on BondScanner (${inr(st.totalInterest)} gross). Informational only; confirm with Form 26AS / AIS before filing.`),
    ];
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="bond-interest-FY${st.fy}.csv"`)
      .send('﻿' + lines.join('\r\n'));
  });

  app.get(`${P}/bonds/search`, async (req) => {
    userOf(req);
    const q = z.object({ q: z.string().min(2).max(60) }).parse(req.query);
    const res = await c.bonds.search(q.q, 8);
    return { results: res.map((b) => ({ isin: b.isin, name: b.name, issuer: b.issuer, rating: b.rating, couponRate: b.couponRate, frequency: b.frequency, maturityDate: b.maturityDate })) };
  });

  // ---------- imports ----------
  const requireConsent = async (u: string) => {
    if (!(await c.holdings.hasConsent(u, config.consentVersion))) throw new HttpError(403, 'consent_required', 'Please accept the Terms & Conditions to add your holdings.');
  };

  // Up to 5 files in one request. Field "file" repeated; passwords as "password_<index>" (0-based, in file order).
  app.post(`${P}/imports`, async (req) => {
    // Consent is given with the tick box on the Check screen and enforced at commit.
    // Files are only read in memory and deleted; nothing is saved before consent.
    const u = userOf(req);
    const files: { filename: string; mime: string; data: Uint8Array; password?: string }[] = [];
    const passwords: Record<number, string> = {};
    for await (const part of (req as any).parts()) {
      if (part.type === 'file' && part.fieldname === 'file') {
        if (files.length >= MAX_FILES) throw new HttpError(400, 'too_many_files', `Add up to ${MAX_FILES} files at a time`);
        files.push({ filename: part.filename, mime: part.mimetype, data: new Uint8Array(await part.toBuffer()) });
      } else if (part.type === 'field' && /^password_\d$/.test(part.fieldname) && part.value) passwords[Number(part.fieldname.slice(9))] = String(part.value);
    }
    files.forEach((f, i) => (f.password = passwords[i]));
    const out = await c.imports.fromFiles(u, files);
    await c.holdings.track(u, 'eh_import_parsed', {
      files: out.files.length,
      fileStatuses: out.files.map((f) => f.status),
      rows: out.rows.length,
      skipped: out.skipped.length,
      matched: out.rows.filter((r) => r.status === 'ready').length,
    });
    return out;
  });

  app.post(`${P}/imports/manual`, async (req) => {
    const u = userOf(req);
    const b = z.object({ rows: z.array(draftRow.omit({ key: true, confidence: true })).min(1).max(200) }).parse(req.body);
    const out = await c.imports.manual(u, b.rows);
    await c.holdings.track(u, 'eh_template_uploaded', { rows: b.rows.length });
    return out;
  });

  /** "Continue where you left off": the latest unfinished import, if any. */
  app.get(`${P}/imports/pending`, async (req) => ({ pending: await c.imports.pending(userOf(req)) }));

  app.post(`${P}/imports/:id/review`, async (req) => {
    const u = userOf(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const imp = await c.imports.get(u, id);
    const b = z
      .object({
        rows: z.array(draftRow).max(200),
        replacePortfolioId: z.string().uuid().optional(),
        alsoImportIds: z.array(z.string().uuid()).max(10).optional(),
        removedFiles: z.array(z.string()).max(10).optional(),
      })
      .parse(req.body);
    for (const r of b.rows) if (r.customTerms) {
      const err = validateCustomTerms(r.customTerms, todayOf(req));
      if (err) throw new HttpError(400, 'invalid_details', err);
    }
    await c.imports.saveRows(u, id, b.rows);
    const rows = await c.imports.review(b.rows);
    const committable = ImportService.isCommittable(rows);
    const usable = rows.filter((r) => r.isin && r.units && r.units > 0).map((r) => ({ isin: r.isin!, units: r.units! }));
    const ownership = await c.imports.ownership(u, [id, ...(b.alsoImportIds ?? [])], b.removedFiles);
    const statementPan = ownership.files.find((f) => f.pan)?.pan ?? null;
    const match = committable ? await c.holdings.matchAgainstSaved(u, usable, b.replacePortfolioId, imp.statement_date, statementPan, ownership.overall) : null;
    const already = await c.holdings.alreadyIn(u, usable.map((r) => r.isin));
    const today = todayOf(req);
    const ageDays = imp.statement_date ? Math.round((Date.parse(today) - Date.parse(imp.statement_date)) / 864e5) : null;
    const notices: { kind: string; message: string }[] = [];
    if (match?.olderThanSaved)
      notices.push({ kind: 'older_statement', message: `This statement is dated ${formatDateNumeric(imp.statement_date!)}, older than the one already saved (${formatDateNumeric(match.savedStatementDate!)}). Holdings may be out of date.` });
    else if (ageDays != null && ageDays > 30)
      notices.push({ kind: 'old_statement', message: `This statement is dated ${formatDateNumeric(imp.statement_date!)}. Holdings may have changed since then.` });
    return {
      rows: rows.map((r) => ({ ...r, alreadyIn: r.isin ? already.get(r.isin) ?? [] : [] })),
      committable,
      match,
      statementDate: imp.statement_date,
      notices,
      ownership,
    };
  });

  // ---------- "Send us your holdings in any format": we add them within 24 hours ----------
  const ASSISTED_MAX = 4 * 1024 * 1024; // Vercel functions take requests up to ~4.5 MB
  app.post(`${P}/assisted`, async (req) => {
    const u = userOf(req);
    // Sharing a file with our team also needs the T&C consent (same as saving holdings).
    await requireConsent(u);
    let file: { fileName: string; mime: string; data: Uint8Array } | null = null;
    let note = '';
    for await (const part of (req as any).parts()) {
      if (part.type === 'file' && part.fieldname === 'file' && !file) {
        const buf: Buffer = await part.toBuffer();
        if (buf.byteLength > ASSISTED_MAX) throw new HttpError(413, 'too_large', 'File size must be 4 MB or less. For a larger file, please share a screenshot or split the file.');
        file = { fileName: part.filename || 'file', mime: part.mimetype || 'application/octet-stream', data: new Uint8Array(buf) };
      } else if (part.type === 'field' && part.fieldname === 'note') note = String(part.value ?? '');
    }
    if (!file || !file.data.byteLength) throw new HttpError(400, 'no_file', 'Please choose a file to send.');
    const saved = await c.holdings.addAssisted(u, { ...file, note });
    // Tell the team (Slack and/or email, whichever is configured). Never fails the upload.
    const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'bond-portfolio-tracker.vercel.app');
    const proto = String(req.headers['x-forwarded-proto'] ?? (host.startsWith('localhost') ? 'http' : 'https')).split(',')[0];
    await sendAssistedAlert(
      { fileName: file.fileName, size: file.data.byteLength, note: note.trim() || null, who: await c.holdings.userLabel(u), adminUrl: `${proto}://${host}/bond-portfolio/admin` },
      process.env,
      (m) => req.log.warn(m),
    ).catch(() => undefined);
    return saved;
  });
  app.get(`${P}/assisted`, async (req) => ({ requests: await c.holdings.myAssisted(userOf(req)) }));

  // ---------- steps only the browser sees, for the adoption funnel ----------
  const CLIENT_EVENTS = ['eh_add_opened', 'eh_template_downloaded', 'eh_click'] as const;
  app.post(`${P}/events`, async (req) => {
    const u = userOf(req);
    const b = z.object({ name: z.enum(CLIENT_EVENTS), props: z.record(z.string(), z.union([z.string(), z.number()])).optional() }).parse(req.body);
    // Button clicks carry only the button's id (e.g. "add_holdings_table").
    if (b.name === 'eh_click' && !/^[a-z0-9_]{2,40}$/.test(String(b.props?.target ?? ''))) throw new HttpError(400, 'bad_target', 'Unknown button');
    await c.holdings.track(u, b.name, b.props ?? {});
    return { ok: true };
  });

  // ---------- who is using the tool (name + email on first use) ----------
  app.get(`${P}/profile`, async (req) => {
    const u = userOf(req);
    // Inside bondscanner.com: the gateway (verified by GATEWAY_SECRET in userOf) passes the logged-in user's name and
    // email, so the person is known without any form. Kept up to date on each visit.
    const name = req.headers[config.userNameHeader];
    const email = req.headers[config.userEmailHeader];
    if (config.gatewaySecret && typeof email === 'string' && email.includes('@')) {
      const n = typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : email.split('@')[0];
      const have = await c.holdings.profile(u);
      if (!have || have.email !== email.trim().toLowerCase() || have.name !== n) await c.holdings.setProfile(u, { name: n, email: email.trim().toLowerCase() });
    }
    return { profile: await c.holdings.profile(u) };
  });
  app.post(`${P}/profile`, async (req) => {
    const u = userOf(req);
    const b = z
      .object({
        name: z.string().trim().min(2, 'Enter your name').max(80),
        email: z.string().trim().toLowerCase().max(120).email('Enter a valid email address'),
      })
      .parse(req.body);
    return { profile: await c.holdings.setProfile(u, b) };
  });

  app.post(`${P}/imports/:id/commit`, async (req) => {
    const u = userOf(req);
    await requireConsent(u);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const imp = await c.imports.get(u, id);
    if (imp.status === 'committed') throw new HttpError(409, 'already_committed', 'These holdings have already been saved.');
    const b = z
      .object({
        rows: z.array(commitRow).min(1).max(200),
        mode: z.enum(['new', 'replace', 'add_new_only', 'append']),
        name: z.string().max(40).optional(),
        portfolioId: z.string().uuid().optional(),
        soldIsins: z.array(z.string()).optional(),
        newHolding: z.boolean().optional(),
        replaceLots: z.array(z.object({ isin: z.string(), acquiredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })).max(200).optional(),
        alsoImportIds: z.array(z.string().uuid()).max(10).optional(),
        removedFiles: z.array(z.string()).max(10).optional(),
        ownership: z.object({ kind: z.enum(['self', 'family']), label: z.string().max(40).optional() }).optional(),
      })
      .parse(req.body);
    // Whose holdings? Someone else's PAN needs "family, with permission"; no PAN found needs a confirmation.
    const own = await c.imports.ownership(u, [id, ...(b.alsoImportIds ?? [])], b.removedFiles);
    if (own.overall === 'other' && b.ownership?.kind !== 'family')
      throw new HttpError(422, 'ownership_unconfirmed', 'This statement is in someone else’s name. Confirm it is a family member’s and you have their permission, or remove the file.');
    if (own.overall === 'unknown' && !b.ownership)
      throw new HttpError(422, 'ownership_unconfirmed', 'Confirm these are your or your family’s holdings.');
    const other = own.files.find((f) => f.owner === 'other');
    const selfFile = own.files.find((f) => f.owner === 'self');
    const owner = !own.enabled
      ? { kind: 'self' as const }
      : b.ownership
      ? { kind: b.ownership.kind, label: b.ownership.label, panMasked: (other ?? selfFile)?.pan ?? null, holder: (other ?? selfFile)?.holder ?? null }
      : { kind: 'self' as const, panMasked: selfFile?.pan ?? null, holder: selfFile?.holder ?? null };
    if (b.mode !== 'new' && owner.kind === 'family' && b.portfolioId) {
      const target = (await c.holdings.items(u)).portfolios.find((p) => p.id === b.portfolioId);
      if (target && target.ownerType !== 'family') throw new HttpError(422, 'owner_mismatch', 'Family holdings are kept separate. Add them as a separate holding.');
    }
    const res = await c.holdings.commit(u, { ...b, statementDate: imp.statement_date, owner }, todayOf(req));
    await c.imports.markCommitted(u, id, res.portfolioId);
    // Files added later on the Check screen: keep their hashes so the same file is caught next time.
    for (const extra of b.alsoImportIds ?? []) await c.imports.markCommitted(u, extra, res.portfolioId);
    const ov = await c.holdings.overview(u, res.portfolioId, todayOf(req));
    await c.holdings.track(u, `eh_portfolio_${b.mode}`, { rows: b.rows.length, notify: b.rows.filter((r) => r.notify).length, method: imp.method });
    return { ...res, summary: ov.summary, holdingsCount: ov.holdings.length, awaitingCount: ov.awaiting.length };
  });

  app.delete(`${P}/imports/:id`, async (req) => {
    const u = userOf(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await c.imports.discard(u, id);
    return { ok: true };
  });

  // ---------- portfolios ----------
  app.patch(`${P}/portfolios/:id`, async (req) => {
    const u = userOf(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const b = z.object({ name: z.string().min(2).max(40) }).parse(req.body);
    return c.holdings.rename(u, id, b.name);
  });

  app.delete(`${P}/portfolios/:id`, async (req) => {
    const u = userOf(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await c.holdings.remove(u, id);
    await c.holdings.track(u, 'eh_portfolio_deleted');
    return { ok: true };
  });

  app.patch(`${P}/portfolios/:id/holdings/:isin`, async (req) => {
    const u = userOf(req);
    const p = z.object({ id: z.string(), isin: z.string().length(12) }).parse(req.params);
    const b = z.object({ units: z.number().positive() }).parse(req.body);
    await c.holdings.setUnits(u, p.id, p.isin, b.units);
    return { ok: true };
  });

  // "Add details": date of investment, units, invested amount and yield (same fields as Add manually).
  app.put(`${P}/holdings/:id/investment`, async (req) => {
    const u = userOf(req);
    const p = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z
      .object({ units: z.number().int().positive(), acquiredOn: isoDate, investedAmount: z.number().positive(), purchaseYield: z.number().min(0).max(50), issuerName: z.string().max(ISSUER_NAME_MAX).optional() })
      .parse(req.body);
    await c.holdings.setInvestment(u, p.id, b, todayOf(req));
    await c.holdings.track(u, 'eh_investment_details_added');
    return { ok: true };
  });

  // "Add details" for a bond still awaiting data (opened from the reminder or the External page).
  app.put(`${P}/holdings/:id/details`, async (req) => {
    const u = userOf(req);
    const p = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ customTerms }).parse(req.body);
    await c.holdings.addDetails(u, p.id, b.customTerms, todayOf(req));
    await c.holdings.track(u, 'eh_details_added');
    return { ok: true };
  });

  app.delete(`${P}/portfolios/:id/holdings/:isin`, async (req) => {
    const u = userOf(req);
    const p = z.object({ id: z.string(), isin: z.string().length(12) }).parse(req.params);
    return { ok: true, ...(await c.holdings.removeHolding(u, p.id, p.isin)) };
  });

  // Remove one bond (row menu → Remove bond). The holding is deleted when its last bond goes.
  app.delete(`${P}/holdings/:id`, async (req) => {
    const u = userOf(req);
    const p = z.object({ id: z.string().uuid() }).parse(req.params);
    const res = await c.holdings.removeHoldingById(u, p.id);
    await c.holdings.track(u, 'eh_holding_removed');
    return { ok: true, ...res };
  });

  // ---------- bond directory (admin) ----------
  // Upload a CSV/.xlsx bond directory: header x-admin-token = EH_ADMIN_TOKEN. Switched off when EH_ADMIN_TOKEN is unset.
  const requireAdmin = (req: FastifyRequest) => {
    const given = Buffer.from(String(req.headers['x-admin-token'] ?? ''));
    const want = Buffer.from(config.adminToken);
    if (!config.adminToken) throw new HttpError(404, 'not_found', 'Not found');
    if (given.length !== want.length || !timingSafeEqual(given, want)) throw new HttpError(401, 'admin_only', 'Admin key missing or wrong');
  };

  app.post(`${P}/admin/bond-directory`, async (req) => {
    requireAdmin(req);
    const file = await (req as any).file();
    if (!file) throw new HttpError(400, 'no_file', 'Attach the directory as a file field named "file"');
    const name = String(file.filename ?? 'directory');
    const { bonds, problems } = await parseDirectoryFile(name, new Uint8Array(await file.toBuffer()));
    // ?dryRun=1 checks the file without saving anything.
    const dryRun = ['1', 'true'].includes(String((req.query as any)?.dryRun ?? ''));
    if (!dryRun && bonds.length) await c.directory.save(bonds, name);
    return { file: name, saved: dryRun ? 0 : bonds.length, valid: bonds.length, problems, dryRun };
  });

  // Fill the directory from bondscanner.com's live bonds (terms + payout schedule). Takes ~30 s; ?dryRun=1 reads without saving.
  app.post(`${P}/admin/bond-directory/sync-bondscanner`, async (req) => {
    requireAdmin(req);
    const dryRun = ['1', 'true'].includes(String((req.query as any)?.dryRun ?? ''));
    // 60 ms between bond pages keeps a full sync (127 bonds) inside a 60 s serverless limit.
    const res = await fetchBondScannerBonds({ api: config.bondScannerApiUrl, site: config.bondScannerSiteUrl, delayMs: 60, log: (m) => req.log.info(m) });
    if (!dryRun && res.bonds.length) await c.directory.save(res.bonds, 'bondscanner.com');
    return { listed: res.listed, valid: res.bonds.length, saved: dryRun ? 0 : res.bonds.length, problems: res.problems, dryRun };
  });

  // Daily refresh by Vercel Cron: Vercel sends "Authorization: Bearer <CRON_SECRET>". Nothing runs without the secret.
  app.get(`${P}/cron/sync-bondscanner`, async (req) => {
    const secret = process.env.CRON_SECRET ?? '';
    const given = Buffer.from(String(req.headers.authorization ?? ''));
    const want = Buffer.from(`Bearer ${secret}`);
    if (!secret) throw new HttpError(404, 'not_found', 'Not found');
    if (given.length !== want.length || !timingSafeEqual(given, want)) throw new HttpError(401, 'cron_only', 'Not allowed');
    const res = await fetchBondScannerBonds({ api: config.bondScannerApiUrl, site: config.bondScannerSiteUrl, delayMs: 60, log: (m) => req.log.info(m) });
    if (res.bonds.length) await c.directory.save(res.bonds, 'bondscanner.com');
    return { listed: res.listed, saved: res.bonds.length, problems: res.problems.length };
  });

  // Feature adoption for the admin page (/bond-portfolio/admin): header x-admin-token = EH_ADMIN_TOKEN.
  app.get(`${P}/admin/stats`, async (req) => {
    requireAdmin(req);
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).parse(req.query);
    return c.holdings.adminStats(days);
  });

  // Files sent in any format: list, download, mark as added (admin key).
  app.get(`${P}/admin/assisted`, async (req) => {
    requireAdmin(req);
    return { requests: await c.holdings.adminAssisted() };
  });
  app.get(`${P}/admin/assisted/:id/file`, async (req, reply) => {
    requireAdmin(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const f = await c.holdings.adminAssistedFile(id);
    reply.header('content-type', f.mime || 'application/octet-stream');
    reply.header('content-disposition', `attachment; filename="${f.file_name.replace(/["\\\r\n]/g, '_')}"`);
    return reply.send(Buffer.from(f.data));
  });
  // Delete the stored file (frees space); the request record stays.
  app.delete(`${P}/admin/assisted/:id/file`, async (req) => {
    requireAdmin(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await c.holdings.adminAssistedDeleteFile(id);
    return { ok: true };
  });
  // The team adds the visitor's holdings (read from their file) into that visitor's account; the request is marked done.
  app.post(`${P}/admin/assisted/:id/holdings`, async (req) => {
    requireAdmin(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z
      .object({
        rows: z
          .array(
            z.object({
              isin: z.string().length(12),
              issuerName: z.string().trim().min(2).max(ISSUER_NAME_MAX),
              units: z.number().int().positive(),
              investedAmount: z.number().positive(),
              acquiredOn: isoDate,
              purchaseYield: z.number().min(0).max(50),
            }),
          )
          .min(1)
          .max(200),
      })
      .parse(req.body);
    const userId = await c.holdings.assistedUser(id);
    const draft = await c.imports.manual(userId, b.rows.map((r) => ({ isin: r.isin, nameHint: r.issuerName, units: r.units, investedAmount: r.investedAmount, acquiredOn: r.acquiredOn, purchaseYield: r.purchaseYield })));
    const bad = draft.rows.filter((r) => r.status === 'bad_isin' || r.status === 'needs_units');
    if (bad.length) throw new HttpError(400, 'invalid_rows', `Please check these ISINs: ${bad.map((r) => r.isin ?? '?').join(', ')}`);
    const res = await c.holdings.commit(
      userId,
      {
        rows: draft.rows.map((r) => ({ isin: r.isin!, units: r.units!, investedAmount: r.investedAmount, acquiredOn: r.acquiredOn, purchaseYield: r.purchaseYield, issuerName: r.nameHint, notify: r.status === 'awaiting' || undefined })),
        mode: 'append',
        owner: { kind: 'self' },
      },
      todayOf(req),
    );
    await c.imports.markCommitted(userId, draft.importId, res.portfolioId);
    await c.holdings.adminAssistedAdded(id, b.rows.length);
    await c.holdings.track(userId, 'eh_assisted_done', { rows: b.rows.length });
    return { ok: true, added: b.rows.length, holding: res.name };
  });

  app.post(`${P}/admin/assisted/:id/done`, async (req) => {
    requireAdmin(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { done } = z.object({ done: z.boolean().default(true) }).parse(req.body ?? {});
    await c.holdings.adminAssistedDone(id, done);
    return { ok: true };
  });

  app.get(`${P}/admin/bond-directory`, async (req) => {
    requireAdmin(req);
    const bonds = await c.directory.list();
    return { count: bonds.length, bonds };
  });

  app.get(`${P}/notification-prefs`, async (req) => c.holdings.prefs(userOf(req)));
  app.put(`${P}/notification-prefs`, async (req) => {
    const u = userOf(req);
    const b = prefsSchema.parse(req.body);
    await c.holdings.setPrefs(u, b);
    return b;
  });
}
