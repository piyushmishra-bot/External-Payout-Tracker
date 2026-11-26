import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createPgliteDb } from '../src/db';
import { buildContainer, type Container } from '../src/container';
import { buildApp } from '../src/server';
import { config } from '../src/config';
import { FixtureBondProvider, FixtureInternalHoldings, StructuralIsinDirectory } from '../src/providers/fixture';
import { NoOcr } from '../src/parsers/image';
import { drainOutbox, planDay, syncBonds } from '../src/notify/worker';
import { LogSender } from '../src/notify/channels';
import { pickQuantity, rowsFromLines } from '../src/parsers/extract';
import { mapRow } from '../src/providers/snape';
import { DeridataBondProvider } from '../src/providers/deridata';
import { FIXTURE_BONDS, type BondTerms } from '@eh/core';

process.env.NODE_ENV = 'test';
const USER = 'test-user-1';
const TODAY = '2026-11-17';
const H = { 'x-user-id': USER, 'x-eh-today': TODAY };
const P = '/v1/external-holdings';

// A bond that is NOT in the directory at first; the sync adds it later (Notify me).
const LATE_BOND: BondTerms = { ...FIXTURE_BONDS[0], isin: 'INE0LTB07012', issuer: 'Lateral Bonds Ltd', name: 'Lateral Bonds Dec ’29', maturityDate: '2029-12-10' };
const provider = new FixtureBondProvider([...FIXTURE_BONDS]);

let c: Container;
let app: Awaited<ReturnType<typeof buildApp>>;

type F = { name: string; mime: string; data: Uint8Array };
function multipart(files: F[], fields: Record<string, string> = {}, headers: Record<string, string> = H) {
  const boundary = '----eh' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const f of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${f.name}"\r\nContent-Type: ${f.mime}\r\n\r\n`));
    parts.push(Buffer.from(f.data));
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
const csv = (name: string, body: string): F => ({ name, mime: 'text/csv', data: new TextEncoder().encode(body) });
const upload = async (files: F[], fields: Record<string, string> = {}) => app.inject({ method: 'POST', url: `${P}/imports`, ...multipart(files, fields) });
const review = async (id: string, rows: unknown[], replacePortfolioId?: string) =>
  (await app.inject({ method: 'POST', url: `${P}/imports/${id}/review`, headers: H, payload: { rows, replacePortfolioId } })).json();
// Most tests upload files without a PAN (or type bonds), so they confirm "my holdings" by default.
const commit = async (id: string, body: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `${P}/imports/${id}/commit`, headers: H, payload: 'ownership' in body ? body : { ...body, ownership: { kind: 'self' } } });
const toCommit = (rows: any[]) => rows.map((r) => ({ isin: r.isin, units: r.units, customTerms: r.customTerms, notify: r.notify }));
const overview = async (scope = 'all') => (await app.inject({ method: 'GET', url: `${P}/overview?scope=${scope}`, headers: H })).json();

async function pdfBytes(lines: string[]) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([820, 420]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  lines.forEach((l, i) => page.drawText(l, { x: 20, y: 390 - i * 22, size: 10, font }));
  return pdf.save();
}

beforeAll(async () => {
  c = await buildContainer({ db: await createPgliteDb(), providers: [provider], directory: new StructuralIsinDirectory(), internal: new FixtureInternalHoldings(), ocr: new NoOcr() });
  app = await buildApp(c);
});
afterAll(async () => app?.close());

describe('auth, consent, scope', () => {
  it('rejects requests without a user', async () => {
    expect((await app.inject({ method: 'GET', url: `${P}/status` })).statusCode).toBe(401);
  });
  it('reads files without saving, but requires the consent tick before saving', async () => {
    const r = await upload([csv('a.csv', 'ISIN,Qty\nINE0AST07019,5\n')]);
    expect(r.statusCode).toBe(200);
    const b = r.json();
    const c1 = await commit(b.importId, { mode: 'new', rows: [{ isin: 'INE0AST07019', units: 5 }] });
    expect(c1.statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `${P}/consent`, headers: H })).statusCode).toBe(200);
    await app.inject({ method: 'DELETE', url: `${P}/imports/${b.importId}`, headers: H });
  });
  it('External totals are external-only: BondScanner purchases are not included', async () => {
    const o = await overview();
    expect(o.portfolios).toEqual([]);
    expect(o.summary.principal).toBe(0);
  });
});

let pid = '';

describe('Upload edge cases (sheet rows 1-4) and multi-file', () => {
  it('reads several files at once; a bad file fails alone; same bond across files adds units', async () => {
    const good = csv('Zerodha.csv', 'Statement as on 15-Nov-2026\nISIN,Security Name,Quantity\nINE0AST07019,Aster,3\nINE0BHF07027,Brightline,10\nINE0QXZ01015,Equity Ltd,100\n');
    const second = await pdfBytes(['Holdings as on 16-Nov-2026', 'INE0AST07019  ASTER FINANCE LTD 11.25% NCD 2028   2.000', 'INE0KPC08018  KAVERI POWER 7.85 2031   1.000']);
    const broken = { name: 'broken.pdf', mime: 'application/pdf', data: new TextEncoder().encode('%PDF-1.7 garbage') };
    const empty = csv('empty.csv', 'ISIN,Quantity\n');
    const docx = { name: 'notes.docx', mime: 'application/msword', data: new Uint8Array([1, 2, 3]) };
    const r = await upload([good, { name: 'Grip.pdf', mime: 'application/pdf', data: second }, broken, empty, docx]);
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.files.map((f: any) => f.status)).toEqual(['read', 'read', 'unreadable', 'empty', 'unsupported']);
    expect(b.files[2].message).toContain('could not read');
    expect(b.files[3].message).toBe('No holdings found in this file.');
    expect(b.skipped.map((s: any) => s.isin)).toEqual(['INE0QXZ01015']);
    const aster = b.rows.find((x: any) => x.isin === 'INE0AST07019');
    expect(aster.units).toBe(5); // 3 + 2 from two files
    expect(aster.files).toEqual(['Zerodha.csv', 'Grip.pdf']);
    expect(b.statementDate).toBe('2026-11-16');
    expect(b.rows).toHaveLength(3);

    const rv = await review(b.importId, b.rows.map((x: any) => ({ ...x, ok: true })));
    expect(rv.committable).toBe(true);
    expect(rv.match).toBeNull();
    const cm = await commit(b.importId, { mode: 'new', rows: toCommit(rv.rows) });
    expect(cm.statusCode).toBe(200);
    pid = cm.json().portfolioId;
    expect(cm.json().name).toBe('My holdings'); // no name field: auto-named
  });

  it('locked PDF asks for the password, then reads with it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eh-'));
    writeFileSync(join(dir, 'plain.pdf'), await pdfBytes(['INE0PNL07049  PINNACLE LEASING 9.80% NCD   4.000']));
    execFileSync('qpdf', ['--encrypt', 'ABCDE1234F', 'owner', '256', '--', join(dir, 'plain.pdf'), join(dir, 'locked.pdf')]);
    const locked = { name: 'CAS.pdf', mime: 'application/pdf', data: new Uint8Array(readFileSync(join(dir, 'locked.pdf'))) };
    const r1 = (await upload([locked])).json();
    expect(r1.files[0].status).toBe('password_required');
    const r2 = (await upload([locked], { password_0: 'wrong' })).json();
    expect(r2.files[0].status).toBe('password_incorrect');
    const r3 = (await upload([locked], { password_0: 'ABCDE1234F' })).json();
    expect(r3.files[0].status).toBe('read');
    expect(r3.rows[0]).toMatchObject({ isin: 'INE0PNL07049', units: 4 });
    await app.inject({ method: 'DELETE', url: `${P}/imports/${r3.importId}`, headers: H });
  });

  it('the same file uploaded again is caught and skipped', async () => {
    const again = csv('Zerodha.csv', 'Statement as on 15-Nov-2026\nISIN,Security Name,Quantity\nINE0AST07019,Aster,3\nINE0BHF07027,Brightline,10\nINE0QXZ01015,Equity Ltd,100\n');
    const r = (await upload([again])).json();
    expect(r.files[0].status).toBe('duplicate_file');
    expect(r.rows).toEqual([]);
  });
});

describe('Extraction edge cases (sheet rows 5-9)', () => {
  it('flags invalid ISINs, missing units, zero/negative units and unknown bonds instead of dropping them', async () => {
    const f = csv('mixed.csv', 'ISIN,Quantity\nINE0AST07018,5\nINE0MIT07031,\nINE0ZRL08013,0\nINE0CVC07023,-2\nINE0LTB07012,3\n');
    const b = (await upload([f])).json();
    const st = Object.fromEntries(b.rows.map((r: any) => [r.isin, r.status]));
    expect(st).toEqual({ INE0AST07018: 'bad_isin', INE0MIT07031: 'needs_units', INE0ZRL08013: 'needs_units', INE0CVC07023: 'needs_units', INE0LTB07012: 'awaiting' }); // unknown bond: no action needed
    const rv1 = await review(b.importId, b.rows);
    expect(rv1.committable).toBe(false);

    // Fix: ISIN corrected, units entered, negative → removed. Unknown bond stays Details awaited.
    const fixed = b.rows
      .filter((r: any) => r.isin !== 'INE0CVC07023')
      .map((r: any) =>
        r.isin === 'INE0AST07018' ? { ...r, isin: 'INE0AST07019' } : !r.units ? { ...r, units: 2 } : r,
      );
    const rv2 = await review(b.importId, fixed);
    expect(rv2.committable).toBe(true);
    expect(rv2.rows.find((r: any) => r.isin === 'INE0LTB07012').status).toBe('awaiting');
    // Already-imported bond is flagged per row (sheet: same ISIN, check before adding).
    expect(rv2.rows.find((r: any) => r.isin === 'INE0AST07019').alreadyIn).toEqual([{ portfolioId: pid, name: 'My holdings', units: 5 }]);
    const cm = await commit(b.importId, { mode: 'new', rows: toCommit(rv2.rows) });
    expect(cm.json().name).toBe('My holdings 2');
    expect(cm.json().awaitingCount).toBe(1);

    // Different brokers, same bond → kept separately in each holding.
    const o = await overview();
    expect(o.overlaps.map((x: any) => x.isin)).toContain('INE0AST07019');
    expect(o.awaiting).toEqual([expect.objectContaining({ isin: 'INE0LTB07012', name: 'Details awaited' })]);
    expect(o.holdings.some((h: any) => h.isin === 'INE0LTB07012')).toBe(false); // out of totals
  });

  it('manual details: coupon, maturity, frequency and face value; no upper limit; replaced by verified data later', async () => {
    const b = (await app.inject({ method: 'POST', url: `${P}/imports/manual`, headers: H, payload: { rows: [{ isin: 'INE0XYZ07016', units: 10 }] } })).json();
    const bad = await app.inject({ method: 'POST', url: `${P}/imports/${b.importId}/review`, headers: H, payload: { rows: [{ ...b.rows[0], customTerms: { couponRate: 9.25, frequency: 4, maturityDate: '2029-03-15' } }] } });
    expect(bad.statusCode).toBe(400);
    const pastDate = await app.inject({ method: 'POST', url: `${P}/imports/${b.importId}/review`, headers: H, payload: { rows: [{ ...b.rows[0], customTerms: { couponRate: 9.25, faceValue: 10000, frequency: 4, maturityDate: '2025-03-15' } }] } });
    expect(pastDate.json().message).toBe('Maturity date must be in the future');
    const rv = await review(b.importId, [{ ...b.rows[0], customTerms: { couponRate: 65, faceValue: 10000, frequency: 4, maturityDate: '2029-03-15', name: 'Xylo Finance' } }]);
    expect(rv.rows[0].status).toBe('your_details');
    // A typed bond that IS in our data uses the verified terms instead.
    const known = await review(b.importId, [{ key: 'k', isin: 'INE0AST07019', units: 2, confidence: 'high', customTerms: { couponRate: 1, faceValue: 1, frequency: 1, maturityDate: '2030-01-01' } }]);
    expect(known.rows[0].status).toBe('ready');
    expect(known.rows[0].bond.couponRate).toBe(11.25);
    await app.inject({ method: 'DELETE', url: `${P}/imports/${b.importId}`, headers: H });
  });

  it('hint for units that look like an amount never blocks', async () => {
    const rows = await c.imports.review([{ key: 'a', isin: 'INE0AST07019', units: 50000, confidence: 'high' }]);
    expect(rows[0]).toMatchObject({ status: 'check', suggestedUnits: 5 });
    expect(rows[0].status).not.toBe('needs_units');
    const kept = await c.imports.review([{ key: 'a', isin: 'INE0AST07019', units: 50000, confidence: 'high', ok: true }]);
    expect(kept[0].status).toBe('ready');
  });
});

describe('Duplicates and portfolio edge cases (sheet rows 10-17)', () => {
  it('same ISINs and units → "same"', async () => {
    const b = (await app.inject({ method: 'POST', url: `${P}/imports/manual`, headers: H, payload: { rows: [{ isin: 'INE0AST07019', units: 5 }, { isin: 'INE0BHF07027', units: 10 }, { isin: 'INE0KPC08018', units: 1 }] } })).json();
    const rv = await review(b.importId, b.rows);
    expect(rv.match).toMatchObject({ type: 'same', portfolioId: pid });
    await app.inject({ method: 'DELETE', url: `${P}/imports/${b.importId}`, headers: H });
  });

  it('partial overlap → "Add only new bonds" adds just the new ones', async () => {
    const b = (await app.inject({ method: 'POST', url: `${P}/imports/manual`, headers: H, payload: { rows: [{ isin: 'INE0AST07019', units: 9 }, { isin: 'INE0BHF07027', units: 10 }, { isin: 'INE0NMB07013', units: 4 }] } })).json();
    const rv = await review(b.importId, b.rows);
    expect(rv.match.type).toBe('update');
    expect(rv.match.diff.changed).toEqual([{ isin: 'INE0AST07019', from: 5, to: 9 }]);
    const cm = (await commit(b.importId, { mode: 'add_new_only', portfolioId: pid, rows: toCommit(rv.rows) })).json();
    expect(cm).toMatchObject({ added: 1, sold: 0 });
    const o = await overview(pid);
    expect(o.holdings.find((h: any) => h.isin === 'INE0AST07019').units).toBe(5); // unchanged
    expect(o.holdings.some((h: any) => h.isin === 'INE0NMB07013')).toBe(true);
  });

  it('newer statement: missing bonds are kept unless the user marks them sold; received marks survive', async () => {
    const pays = (await app.inject({ method: 'GET', url: `${P}/payouts?scope=${pid}&from=2026-12-01&to=2026-12-31`, headers: H })).json();
    const aster = pays.payouts.find((p: any) => p.isin === 'INE0AST07019');
    await app.inject({ method: 'POST', url: `${P}/payouts/received`, headers: H, payload: { holdingId: aster.holdingId, scheduledDate: aster.scheduledDate, received: true } });

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Holdings');
    ws.addRow(['Holdings statement as on 01-Dec-2026']);
    ws.addRow(['ISIN', 'Bond name', 'No. of bonds']);
    ws.addRow(['INE0AST07019', 'Aster', 5]);
    ws.addRow(['INE0BHF07027', 'Brightline', 6]);
    ws.addRow(['INE0MIT07031', 'Meridian', 8]);
    const b = (await upload([{ name: 'Dec.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: new Uint8Array(await wb.xlsx.writeBuffer()) }])).json();
    expect(b.statementDate).toBe('2026-12-01');
    const rv = await review(b.importId, b.rows.map((r: any) => ({ ...r, ok: true })), pid);
    expect(rv.match.diff.removed.sort()).toEqual(['INE0KPC08018', 'INE0NMB07013']);
    // User says Kaveri was sold, keeps Nimbus.
    const cm = (await commit(b.importId, { mode: 'replace', portfolioId: pid, soldIsins: ['INE0KPC08018'], rows: toCommit(rv.rows) })).json();
    expect(cm).toMatchObject({ added: 1, sold: 1 });
    const o = await overview(pid);
    const isins = o.holdings.map((h: any) => h.isin).sort();
    expect(isins).toEqual(['INE0AST07019', 'INE0BHF07027', 'INE0MIT07031', 'INE0NMB07013']);
    expect(o.portfolios.find((p: any) => p.id === pid).statementDate).toBe('2026-12-01');
    const after = (await app.inject({ method: 'GET', url: `${P}/payouts?scope=${pid}&from=2026-12-01&to=2026-12-31`, headers: H })).json();
    expect(after.payouts.find((p: any) => p.isin === 'INE0AST07019').status).toBe('received');
  });

  it('an older statement than the saved one gets a warning', async () => {
    const b = (await upload([csv('Oct.csv', 'Statement as on 10-Oct-2026\nISIN,Quantity\nINE0AST07019,5\nINE0BHF07027,10\nINE0MIT07031,8\n')])).json();
    const rv = await review(b.importId, b.rows.map((r: any) => ({ ...r, ok: true })), pid);
    expect(rv.notices[0].kind).toBe('older_statement');
    expect(rv.notices[0].message).toContain('older than the one already saved');
    await app.inject({ method: 'DELETE', url: `${P}/imports/${b.importId}`, headers: H });
  });
});

describe('Payout edge cases (sheet rows 18-22)', () => {
  it('past payouts are past, upcoming are upcoming; matured bonds are tagged', async () => {
    const p = (await app.inject({ method: 'GET', url: `${P}/payouts?scope=${pid}`, headers: { ...H, 'x-eh-today': '2026-12-20' } })).json();
    const past = p.payouts.filter((e: any) => e.date < '2026-12-20');
    expect(past.every((e: any) => e.status !== 'upcoming')).toBe(true);
    expect(p.payouts.filter((e: any) => e.date > '2026-12-20').every((e: any) => e.status === 'upcoming')).toBe(true);
    const late = (await app.inject({ method: 'GET', url: `${P}/overview?scope=${pid}`, headers: { ...H, 'x-eh-today': '2028-01-02' } })).json();
    expect(late.holdings.find((h: any) => h.isin === 'INE0MIT07031').matured).toBe(true); // matured Nov 2027
    expect(late.summary.principal).toBeLessThan((await overview(pid)).summary.principal);
  });
  it('user-entered bonds are marked estimated; directory bonds are not', async () => {
    const p = (await app.inject({ method: 'GET', url: `${P}/payouts`, headers: H })).json();
    expect(p.payouts.every((e: any) => e.estimated === false)).toBe(true);
  });
  it('no payouts → empty list (UI shows an empty state)', async () => {
    const p = (await app.inject({ method: 'GET', url: `${P}/payouts?from=2040-01-01&to=2040-12-31`, headers: H })).json();
    expect(p.payouts).toEqual([]);
  });
});

describe('User action edge cases (sheet rows 23-24)', () => {
  it('leaving mid-upload keeps the draft to continue later', async () => {
    const b = (await upload([csv('half.csv', 'ISIN,Quantity\nINE0ZRL08013,7\n')])).json();
    await review(b.importId, [{ ...b.rows[0], units: 8 }]); // edited, then user leaves
    const p = (await app.inject({ method: 'GET', url: `${P}/imports/pending`, headers: H })).json();
    expect(p.pending.importId).toBe(b.importId);
    expect(p.pending.rows[0].units).toBe(8);
    await app.inject({ method: 'DELETE', url: `${P}/imports/${b.importId}`, headers: H });
    expect((await app.inject({ method: 'GET', url: `${P}/imports/pending`, headers: H })).json().pending).toBeNull();
  });

  it('deleting a portfolio removes its payouts and stops its pending reminders', async () => {
    const o = await overview();
    const second = o.portfolios.find((p: any) => p.name === 'My holdings 2');
    await planDay(c.db, c.holdings, c.calendar, '2026-12-06');
    const before = await c.db.query<any>(`SELECT count(*)::int AS n FROM eh_notification_outbox WHERE status='pending'`);
    expect(before[0].n).toBeGreaterThan(0);
    await app.inject({ method: 'DELETE', url: `${P}/portfolios/${second.id}`, headers: H });
    const after = await overview();
    expect(after.portfolios.map((p: any) => p.name)).toEqual(['My holdings']);
    expect(after.awaiting).toEqual([]);
  });
});

describe('v1: ownership check is off', () => {
  it('someone else’s statement saves without any confirmation and stores no PAN', async () => {
    const f = { name: 'Other_v1.pdf', mime: 'application/pdf', data: await pdfBytes(['Name: RAMESH KUMAR   PAN: PQRSX5678K', 'INE0NMB07013  NIMBUS CREDIT NCD   2.000']) };
    const b = (await upload([f])).json();
    expect(b.files[0].owner).toBeUndefined();
    expect(b.files[0].pan).toBeUndefined();
    const rv = await review(b.importId, b.rows.map((r: any) => ({ ...r, ok: true })));
    expect(rv.ownership).toEqual({ enabled: false, overall: 'self', files: [] });
    const cm = await app.inject({ method: 'POST', url: `${P}/imports/${b.importId}/commit`, headers: H, payload: { mode: 'new', rows: toCommit(rv.rows) } });
    expect(cm.statusCode).toBe(200);
    const leak = await c.db.query<any>(`SELECT count(*)::int AS n FROM eh_imports WHERE files::text LIKE '%5678K%'`);
    expect(leak[0].n).toBe(0);
    await app.inject({ method: 'DELETE', url: `${P}/portfolios/${cm.json().portfolioId}`, headers: H });
  });
});

describe('v2: Whose holdings? (EH_OWNERSHIP_CHECK=true)', () => {
  let saved: { c: Container; app: typeof app };
  beforeAll(async () => {
    saved = { c, app };
    c = await buildContainer({ db: await createPgliteDb(), providers: [provider], directory: new StructuralIsinDirectory(), internal: new FixtureInternalHoldings(), ocr: new NoOcr(), ownershipCheck: true });
    app = await buildApp(c);
    // the "someone else's PAN" case expects the user's own Zerodha-style holding to exist
    const seedRows = [{ isin: 'INE0AST07019', units: 5 }, { isin: 'INE0BHF07027', units: 10 }, { isin: 'INE0KPC08018', units: 1 }];
    const m = (await app.inject({ method: 'POST', url: `${P}/imports/manual`, headers: H, payload: { rows: seedRows } })).json();
    await app.inject({ method: 'POST', url: `${P}/consent`, headers: H });
    await app.inject({ method: 'POST', url: `${P}/imports/${m.importId}/commit`, headers: H, payload: { mode: 'new', rows: seedRows, ownership: { kind: 'self' } } });
  });
  afterAll(async () => {
    await app.close();
    ({ c, app } = saved);
  });

  const casPdf = (lines: string[]) => pdfBytes(lines);
  it('own PAN: no confirmation needed', async () => {
    const f = { name: 'Mine.pdf', mime: 'application/pdf', data: await casPdf(['NSDL Consolidated Account Statement', 'Name: TEST USER   PAN: ABCDE1234F', 'INE0CVC07023  CORVUS CAPITAL NCD   2.000']) };
    const b = (await upload([f])).json();
    expect(b.files[0]).toMatchObject({ owner: 'self', pan: 'XXXXX1234F' });
    const rv = await review(b.importId, b.rows.map((r: any) => ({ ...r, ok: true })));
    expect(rv.ownership.overall).toBe('self');
    const cm = await app.inject({ method: 'POST', url: `${P}/imports/${b.importId}/commit`, headers: H, payload: { mode: 'new', rows: toCommit(rv.rows) } });
    expect(cm.statusCode).toBe(200);
    await app.inject({ method: 'DELETE', url: `${P}/portfolios/${cm.json().portfolioId}`, headers: H });
  });

  it('someone else’s PAN: warned, must confirm family; stored masked and tagged', async () => {
    const f = { name: 'Dad_CAS.pdf', mime: 'application/pdf', data: await casPdf(['CDSL Consolidated Account Statement', 'Name: RAMESH KUMAR   PAN: PQRSX5678K', 'INE0AST07019  ASTER FINANCE NCD   5.000', 'INE0BHF07027  BRIGHTLINE HOUSING NCD   10.000', 'INE0KPC08018  KAVERI POWER BOND   1.000']) };
    const b = (await upload([f])).json();
    expect(b.files[0]).toMatchObject({ owner: 'other', pan: 'XXXXX5678K', holder: 'RAMESH KUMAR' });
    const rv = await review(b.importId, b.rows.map((r: any) => ({ ...r, ok: true })));
    expect(rv.ownership.overall).toBe('other');
    // Same bonds as the user's own "Zerodha" holding, but a different person: never offered as an update.
    expect(rv.match).toBeNull();
    const url = `${P}/imports/${b.importId}/commit`;
    const none = await app.inject({ method: 'POST', url, headers: H, payload: { mode: 'new', rows: toCommit(rv.rows) } });
    expect(none.statusCode).toBe(422);
    expect(none.json().error).toBe('ownership_unconfirmed');
    const asSelf = await app.inject({ method: 'POST', url, headers: H, payload: { mode: 'new', rows: toCommit(rv.rows), ownership: { kind: 'self' } } });
    expect(asSelf.statusCode).toBe(422);
    const ok = await app.inject({ method: 'POST', url, headers: H, payload: { mode: 'new', rows: toCommit(rv.rows), ownership: { kind: 'family', label: 'Dad' } } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().name).toBe('Dad’s holdings');
    const o = await overview();
    expect(o.portfolios.find((p: any) => p.name === 'Dad’s holdings')).toMatchObject({ ownerType: 'family', ownerLabel: 'Dad', ownerPan: 'XXXXX5678K' });
    const audit = await c.db.query<any>(`SELECT kind, owner_label, pan_masked, holder_name FROM eh_ownership_confirmations WHERE portfolio_id=$1`, [ok.json().portfolioId]);
    expect(audit).toEqual([{ kind: 'family', owner_label: 'Dad', pan_masked: 'XXXXX5678K', holder_name: 'RAMESH KUMAR' }]);
    // The full third-party PAN is never stored anywhere.
    const leak = await c.db.query<any>(`SELECT count(*)::int AS n FROM eh_imports WHERE files::text LIKE '%PQRSX5678K%'`);
    expect(leak[0].n).toBe(0);
  });

  it('removing the other person’s file lifts the requirement; typed bonds need a one-line confirmation', async () => {
    const f = { name: 'Other.pdf', mime: 'application/pdf', data: await casPdf(['PAN: PQRSX5678K', 'INE0ZRL08013  ZENITH ROADS   3.000']) };
    const b = (await upload([f])).json();
    const url = `${P}/imports/${b.importId}/commit`;
    const removed = await app.inject({ method: 'POST', url, headers: H, payload: { mode: 'new', rows: [{ isin: 'INE0ZRL08013', units: 3 }], removedFiles: ['Other.pdf'] } });
    expect(removed.statusCode).toBe(422); // nothing identifiable left → still needs "my or family" confirmation
    expect(removed.json().message).toContain('Confirm these are your');
    const m = (await app.inject({ method: 'POST', url: `${P}/imports/manual`, headers: H, payload: { rows: [{ isin: 'INE0ZRL08013', units: 3 }] } })).json();
    const mc = await app.inject({ method: 'POST', url: `${P}/imports/${m.importId}/commit`, headers: H, payload: { mode: 'new', rows: [{ isin: 'INE0ZRL08013', units: 3 }] } });
    expect(mc.statusCode).toBe(422);
    const ok = await app.inject({ method: 'POST', url: `${P}/imports/${m.importId}/commit`, headers: H, payload: { mode: 'new', rows: [{ isin: 'INE0ZRL08013', units: 3 }], ownership: { kind: 'self' } } });
    expect(ok.statusCode).toBe(200);
    await app.inject({ method: 'DELETE', url: `${P}/portfolios/${ok.json().portfolioId}`, headers: H });
    await app.inject({ method: 'DELETE', url: `${P}/imports/${b.importId}`, headers: H });
  });
});

describe('Add manually: ISIN, date of investment, units, invested amount, yield', () => {
  it('stores the investment entry and returns it with the bond', async () => {
    const row = { isin: 'INE0PNL07049', units: 3, acquiredOn: '2026-10-01', investedAmount: 30150.5, purchaseYield: 9.95 };
    const m = (await app.inject({ method: 'POST', url: `${P}/imports/manual`, headers: H, payload: { rows: [row] } })).json();
    const rv = await review(m.importId, m.rows);
    expect(rv.rows[0]).toMatchObject({ status: 'ready', acquiredOn: '2026-10-01', investedAmount: 30150.5, purchaseYield: 9.95 });
    await commit(m.importId, { mode: 'add_new_only', portfolioId: pid, rows: [row] });
    const h = (await overview()).holdings.find((x: any) => x.isin === 'INE0PNL07049');
    expect(h).toMatchObject({ units: 3, investedOn: '2026-10-01', investedAmount: 30150.5, purchaseYield: 9.95 });
    await app.inject({ method: 'DELETE', url: `${P}/portfolios/${pid}/holdings/INE0PNL07049`, headers: H });
  });
});

describe('Details awaited: still missing after a day → ask the user', () => {
  it('counts lookups, sends one "add details" reminder, and Add details turns it into an estimated holding', async () => {
    const UNKNOWN = 'INE0UNK07017';
    const b = (await app.inject({ method: 'POST', url: `${P}/imports/manual`, headers: H, payload: { rows: [{ isin: UNKNOWN, units: 4 }] } })).json();
    const rv = await review(b.importId, b.rows);
    expect(rv.rows[0].status).toBe('awaiting');
    expect(rv.committable).toBe(true);
    await commit(b.importId, { mode: 'add_new_only', portfolioId: pid, rows: toCommit(rv.rows) });
    for (let i = 0; i < 3; i++) expect((await syncBonds(c.db, c.bonds, 4)).asked).toBe(0);
    expect((await syncBonds(c.db, c.bonds, 4)).asked).toBe(1);
    expect((await syncBonds(c.db, c.bonds, 4)).asked).toBe(0); // only once
    const msg = await c.db.query<any>(`SELECT title, link FROM eh_notification_outbox WHERE kind='details_needed'`);
    expect(msg[0].title).toContain(UNKNOWN);
    const aw = (await overview()).awaiting.find((a: any) => a.isin === UNKNOWN);
    expect(aw.detailsRequested).toBe(true);
    expect(msg[0].link).toContain(`details=${aw.id}`);
    // Add details = date of investment, units, invested amount, yield (same as Add manually).
    const inv = await app.inject({ method: 'PUT', url: `${P}/holdings/${aw.id}/investment`, headers: H, payload: { units: 5, acquiredOn: '2026-09-01', investedAmount: 5100, purchaseYield: 11.2 } });
    expect(inv.statusCode).toBe(200);
    const future = await app.inject({ method: 'PUT', url: `${P}/holdings/${aw.id}/investment`, headers: H, payload: { units: 5, acquiredOn: '2099-01-01', investedAmount: 5100, purchaseYield: 11.2 } });
    expect(future.statusCode).toBe(400);
    expect((await overview()).awaiting.find((a: any) => a.id === aw.id)).toMatchObject({ units: 5, investedOn: '2026-09-01', investedAmount: 5100, purchaseYield: 11.2 });
    const bad = await app.inject({ method: 'PUT', url: `${P}/holdings/${aw.id}/details`, headers: H, payload: { customTerms: { couponRate: 0, maturityDate: '2029-01-01', frequency: 4, faceValue: 1000 } } });
    expect(bad.statusCode).toBe(400);
    const other = await app.inject({ method: 'PUT', url: `${P}/holdings/${aw.id}/details`, headers: { ...H, 'x-user-id': 'someone-else' }, payload: { customTerms: { couponRate: 9, maturityDate: '2029-01-01', frequency: 4, faceValue: 1000 } } });
    expect(other.statusCode).toBe(404);
    const ok = await app.inject({ method: 'PUT', url: `${P}/holdings/${aw.id}/details`, headers: H, payload: { customTerms: { couponRate: 9, maturityDate: '2029-01-01', frequency: 4, faceValue: 1000 } } });
    expect(ok.statusCode).toBe(200);
    const o = await overview();
    expect(o.awaiting.some((a: any) => a.isin === UNKNOWN)).toBe(false);
    expect(o.holdings.find((h: any) => h.isin === UNKNOWN)).toMatchObject({ verified: false, units: 5 });
    await app.inject({ method: 'DELETE', url: `${P}/portfolios/${pid}/holdings/${UNKNOWN}`, headers: H });
  });
});

describe('Notify me and the 6-hourly sync', () => {
  it('releases a Notify-me bond once the directory has it and tells the user', async () => {
    const b = (await app.inject({ method: 'POST', url: `${P}/imports/manual`, headers: H, payload: { rows: [{ isin: 'INE0LTB07012', units: 3 }] } })).json();
    const rv = await review(b.importId, [{ ...b.rows[0], notify: true }]);
    await commit(b.importId, { mode: 'add_new_only', portfolioId: pid, rows: toCommit(rv.rows) });
    expect((await overview()).awaiting.map((a: any) => a.isin)).toEqual(['INE0LTB07012']);
    (provider as any).bonds.push(LATE_BOND); // Deridata sync brings it in
    const s = await syncBonds(c.db, c.bonds);
    expect(s).toMatchObject({ released: 1, notified: 1 });
    const o = await overview();
    expect(o.awaiting).toEqual([]);
    expect(o.holdings.some((h: any) => h.isin === 'INE0LTB07012')).toBe(true);
    const msg = await c.db.query<any>(`SELECT title FROM eh_notification_outbox WHERE kind='bond_available'`);
    expect(msg[0].title).toContain('Lateral Bonds');
  });
});

describe('reminders, report, management', () => {
  it('plans reminders once and drains them', async () => {
    const r2 = await planDay(c.db, c.holdings, c.calendar, '2026-12-06');
    expect(r2.planned).toBe(0);
    await c.db.query(`UPDATE eh_notification_outbox SET send_after = now() - interval '1 minute' WHERE status='pending'`);
    const d = await drainOutbox(c.db, new LogSender());
    expect(d.sent).toBeGreaterThan(0);
    expect((await drainOutbox(c.db, new LogSender())).sent).toBe(0);
  });
  it('report has rating mix and issuers', async () => {
    const r = (await app.inject({ method: 'GET', url: `${P}/report`, headers: H })).json();
    expect(r.ratingMix.length).toBeGreaterThan(1);
  });
  it('renames, and isolates users', async () => {
    expect((await app.inject({ method: 'PATCH', url: `${P}/portfolios/${pid}`, headers: H, payload: { name: 'Zerodha' } })).json().name).toBe('Zerodha');
    const other = await app.inject({ method: 'PATCH', url: `${P}/portfolios/${pid}/holdings/INE0MIT07031`, headers: { ...H, 'x-user-id': 'someone-else' }, payload: { units: 1 } });
    expect(other.statusCode).toBe(404);
  });
});

describe('parsers and vendor adapters', () => {
  it('pickQuantity prefers 3-decimal quantities and skips coupons and years', () => {
    expect(pickQuantity('ASTER FINANCE 11.25% 2028 5.000 50,000.00'.split(' '))).toBe(5);
    expect(pickQuantity(['10.40%', '2029'])).toBeNull();
  });
  it('keeps OCR-mangled ISINs as rows to fix', () => {
    const r = rowsFromLines(['INE0AST0701 ASTER FINANCE 4'], 't');
    expect(r.rows[0]).toMatchObject({ isin: 'INE0AST0701', invalidIsin: true });
  });
  it('maps a SNAPE-shaped row', () => {
    expect(mapRow({ isin: 'INE0AST07019', issuer_name: 'Aster Finance Ltd', face_value: '1000', coupon_rate: '10.5', interest_frequency: 'Monthly', day_count_convention: 'Actual/Actual', maturity_date: '2028-08-05' })).toMatchObject({ name: 'Aster Finance Aug ’28', frequency: 12 });
  });
  it('calls Deridata with auth', async () => {
    const calls: string[] = [];
    const f = (async (url: string, init: any) => {
      calls.push(`${url} ${init.headers.Authorization}`);
      return new Response(JSON.stringify(url.endsWith('/cashflows') ? [] : { isin: 'INE0AST07019', issuerName: 'Aster', faceValue: 1000, couponRate: 11.25, interestPaymentFrequency: 'Monthly', maturityDate: '2028-08-05' }));
    }) as unknown as typeof fetch;
    const got = await new DeridataBondProvider('https://api.example', 'KEY', 1000, f).getMany(['INE0AST07019']);
    expect(calls[0]).toBe('https://api.example/v1/bonds/INE0AST07019 Bearer KEY');
    expect(got.size).toBe(1);
  });
});

describe('Delete and edit one bond; re-upload after deleting', () => {
  const U2 = { 'x-user-id': 'test-user-edit', 'x-eh-today': TODAY };
  const up = async (files: F[]) => (await app.inject({ method: 'POST', url: `${P}/imports`, ...multipart(files, {}, U2) })).json();
  const ov2 = async () => (await app.inject({ method: 'GET', url: `${P}/overview?scope=all`, headers: U2 })).json();
  const save = async (b: any) => {
    const rv = (await app.inject({ method: 'POST', url: `${P}/imports/${b.importId}/review`, headers: U2, payload: { rows: b.rows } })).json();
    return (await app.inject({ method: 'POST', url: `${P}/imports/${b.importId}/commit`, headers: U2, payload: { mode: 'new', rows: toCommit(rv.rows), ownership: { kind: 'self' } } })).json();
  };
  const file = () => csv('Broker.csv', 'Statement as on 15-Nov-2026\nISIN,Quantity\nINE0AST07019,3\nINE0BHF07027,2\n');

  it('a deleted holding’s file can be uploaded again', async () => {
    await app.inject({ method: 'POST', url: `${P}/consent`, headers: U2 });
    const first = await save(await up([file()]));
    expect((await up([file()])).files[0].status).toBe('duplicate_file');
    await app.inject({ method: 'DELETE', url: `${P}/portfolios/${first.portfolioId}`, headers: U2 });
    const again = await up([file()]);
    expect(again.files[0].status).toBe('read');
    expect(again.rows).toHaveLength(2);
    await save(again);
  });

  it('removes one bond; the file is read again; the last bond takes the holding with it', async () => {
    const o = await ov2();
    const aster = o.holdings.find((h: any) => h.isin === 'INE0AST07019');
    const r = await app.inject({ method: 'DELETE', url: `${P}/holdings/${aster.id}`, headers: U2 });
    expect(r.json()).toMatchObject({ ok: true, portfolioDeleted: false });
    expect((await ov2()).holdings.map((h: any) => h.isin)).toEqual(['INE0BHF07027']);
    // Same file again: read (not skipped), so the removed bond can be added back.
    const b = await up([file()]);
    expect(b.files[0].status).toBe('read');
    await app.inject({ method: 'DELETE', url: `${P}/imports/${b.importId}`, headers: U2 });
    // Someone else cannot remove it.
    const last = (await ov2()).holdings[0];
    expect((await app.inject({ method: 'DELETE', url: `${P}/holdings/${last.id}`, headers: { ...U2, 'x-user-id': 'someone-else' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `${P}/holdings/${last.id}`, headers: U2 })).json()).toMatchObject({ portfolioDeleted: true });
    expect((await ov2()).portfolios).toEqual([]);
  });

  it('edits a bond’s units, date, amount and yield', async () => {
    const saved = await save(await up([file()]));
    const h = (await ov2()).holdings.find((x: any) => x.isin === 'INE0BHF07027');
    const r = await app.inject({ method: 'PUT', url: `${P}/holdings/${h.id}/investment`, headers: U2, payload: { units: 4, acquiredOn: '2026-08-01', investedAmount: 40500, purchaseYield: 10.1 } });
    expect(r.statusCode).toBe(200);
    expect((await ov2()).holdings.find((x: any) => x.id === h.id)).toMatchObject({ units: 4, investedOn: '2026-08-01', investedAmount: 40500, purchaseYield: 10.1 });
    await app.inject({ method: 'DELETE', url: `${P}/portfolios/${saved.portfolioId}`, headers: U2 });
  });

  it('a bond not in our data shows and counts the user’s details once entered', async () => {
    const UNKNOWN = 'INE0UNK07017';
    const b = (await app.inject({ method: 'POST', url: `${P}/imports/manual`, headers: U2, payload: { rows: [{ isin: UNKNOWN, units: 5 }] } })).json();
    const rv = (await app.inject({ method: 'POST', url: `${P}/imports/${b.importId}/review`, headers: U2, payload: { rows: b.rows } })).json();
    await app.inject({ method: 'POST', url: `${P}/imports/${b.importId}/commit`, headers: U2, payload: { mode: 'new', rows: toCommit(rv.rows), ownership: { kind: 'self' } } });
    let o = await ov2();
    expect(o.awaiting[0]).toMatchObject({ isin: UNKNOWN, entered: false });
    expect(o.summary.principal).toBe(0);
    await app.inject({ method: 'PUT', url: `${P}/holdings/${o.awaiting[0].id}/investment`, headers: U2, payload: { units: 5, acquiredOn: '2026-10-01', investedAmount: 4898.61, purchaseYield: 10.5 } });
    o = await ov2();
    expect(o.awaiting[0]).toMatchObject({ entered: true, investedAmount: 4898.61, purchaseYield: 10.5 });
    expect(o.summary).toMatchObject({ principal: 4898.61, avgCoupon: 10.5, holdingsCount: 1 });
    expect(o.portfolios[0]).toMatchObject({ holdingsCount: 1, principal: 4898.61 });
    // No "add details" reminder once the user has entered details.
    await c.db.query(`UPDATE eh_holdings SET lookup_attempts=10 WHERE isin=$1`, [UNKNOWN]);
    const asked = await c.db.query<any>(
      `SELECT count(*)::int AS n FROM eh_holdings h JOIN eh_portfolios p ON p.id=h.portfolio_id WHERE p.user_id='test-user-edit' AND h.details_requested_at IS NOT NULL`,
    );
    await syncBonds(c.db, c.bonds, 4);
    const after = await c.db.query<any>(
      `SELECT count(*)::int AS n FROM eh_holdings h JOIN eh_portfolios p ON p.id=h.portfolio_id WHERE p.user_id='test-user-edit' AND h.details_requested_at IS NOT NULL`,
    );
    expect(after[0].n).toBe(asked[0].n);
  });
});

describe('Bond directory upload (admin)', () => {
  const dirCsv = [
    'ISIN,Name,Issuer,Type,Coupon,Frequency,Maturity,FaceValue,Rating,Rating agency,PayoutPerUnit,Source,Issue date',
    'INE0LN107105,Credit Wise Capital Nov ’28,Credit Wise Capital Private Limited,NCD,11.0,Monthly,19/11/2028,10000,,,,"TEST",18-Nov-2026',
    'INE134E07ED4,Power Finance Corporation Oct ’31,Power Finance Corporation Limited,NCD,5.25,Quarterly,31/10/2031,10000,AAA,CRISIL,,TEST,31-Oct-2026',
    'INE134E07ED5,Bad check digit,X,NCD,9,Monthly,31/10/2031,10000,,,,,',
    'INE0APB07013,Mangalam Nov ’29,Mangalam Global Enterprise Limited,NCD,11.0,Fortnightly,18/11/2029,100000,,,,,',
    'INE0APB07013,Mangalam again,Mangalam,NCD,11.0,Annual,31/02/2029,100000,,,,,',
  ].join('\n');
  const post = (body: string, token?: string, q = '') =>
    app.inject({ method: 'POST', url: `${P}/admin/bond-directory${q}`, ...multipart([csv('dir.csv', body)], {}, token ? { 'x-admin-token': token } : {}) });

  it('is off without EH_ADMIN_TOKEN and needs the right key', async () => {
    expect((await post(dirCsv)).statusCode).toBe(404);
    (config as any).adminToken = 'test-admin';
    expect((await post(dirCsv, 'wrong')).statusCode).toBe(401);
  });

  it('checks every row, saves the valid ones, and the bonds are then known', async () => {
    const dry = (await post(dirCsv, 'test-admin', '?dryRun=1')).json();
    expect(dry).toMatchObject({ valid: 2, saved: 0, dryRun: true });
    expect((await c.bonds.getMany(['INE0LN107105'])).size).toBe(0);
    const r = (await post(dirCsv, 'test-admin')).json();
    expect(r).toMatchObject({ valid: 2, saved: 2 });
    expect(r.problems.map((p: any) => p.row)).toEqual([4, 5, 6]);
    expect(r.problems[0].message).toContain('not valid');
    expect(r.problems[1].message).toContain('Fortnightly');
    expect(r.problems[2].message).toContain('not a date');
    const got = await c.bonds.getMany(['INE0LN107105', 'INE134E07ED4']);
    expect(got.get('INE0LN107105')).toMatchObject({ frequency: 12, couponRate: 11, faceValue: 10000, maturityDate: '2028-11-19', issueDate: '2026-11-18', source: 'directory' });
    expect(got.get('INE134E07ED4')).toMatchObject({ frequency: 4, rating: 'AAA', ratingAgency: 'CRISIL' });
    const list = (await app.inject({ method: 'GET', url: `${P}/admin/bond-directory`, headers: { 'x-admin-token': 'test-admin' } })).json();
    expect(list.count).toBe(2);
    // A statement with one of these ISINs now reads as a known bond, not "Details awaited".
    const up = (await app.inject({ method: 'POST', url: `${P}/imports`, ...multipart([csv('s.csv', 'ISIN,Quantity\nINE0LN107105,2\n')]) })).json();
    const rv = await review(up.importId, up.rows);
    expect(rv.rows[0]).toMatchObject({ isin: 'INE0LN107105', status: 'ready' });
    await app.inject({ method: 'DELETE', url: `${P}/imports/${up.importId}`, headers: H });
    (config as any).adminToken = '';
  });
});

describe('BondScanner live-bond sync (fake site)', () => {
  const page = (isins: [string, string][], hasNext: boolean) => ({ status: 'success', data: isins.map(([isin, ID]) => ({ ID, isin, issuerName: `Bond ${isin}`, ratings: 'A+', payoutFrequency: 'Monthly' })), pageInfo: { hasNext } });
  const deal = (over: any = {}) => ({
    pageProps: {
      isGovernmentBond: false,
      bondDealData: {
        basicDetails: { issuerName: 'UGRO Capital Mar ’31' },
        coupons: { couponRate: 11.65, couponType: 'Fixed', payoutFrequency: 'Monthly' },
        isinDetails: { faceValue: '100000', maturityDate: '2031-03-15T05:30:00+05:30', dateOfIssuance: '2026-03-15T05:30:00+05:30', seniority: 'Subordinate Tier 2' },
        rating: { rating: 'A+', ratingAgency: 'India Ratings' },
        payoutSchedule: { data: [
          { date: '2026-12-15T05:30:00+05:30', interest: '957.53', principal: '0.00', total: '957.53' },
          { date: '2031-03-15T05:30:00+05:30', interest: '893.70', principal: '100000.00', total: '100893.70' },
        ] },
        ...over,
      },
    },
  });
  // Fake bondscanner.com: 2 list pages, the build id changes after the first detail (a redeploy), one bond has no face value.
  let build = 'b1';
  const calls: string[] = [];
  const fakeFetch = (async (url: string) => {
    calls.push(url);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (url.includes('/v1/issuer/isins?page=0')) return json(page([['INE583D08081', 'D1'], ['INE134E07ED4', 'D2']], true));
    if (url.includes('/v1/issuer/isins?page=1')) return json(page([['INE0LN107105', 'D3']], false));
    if (url.endsWith('/bonds')) return new Response(`<script id="__NEXT_DATA__">{"buildId":"${build}"}</script>`);
    const m = /_next\/data\/([^/]+)\/deal-details\/([^/]+)\/([^/]+)\.json$/.exec(url);
    if (!m) return json({}, 404);
    if (m[1] !== build) return json({}, 404);
    if (m[2] === 'INE583D08081') { build = 'b2'; return json(deal()); }
    if (m[2] === 'INE134E07ED4') return json(deal({ coupons: { couponRate: 5.25, couponType: 'Fixed', payoutFrequency: 'Quarterly' }, basicDetails: { issuerName: 'PFC Oct ’31' } }));
    return json(deal({ isinDetails: { maturityDate: '2028-11-19T05:30:00+05:30' } }));
  }) as typeof fetch;

  it('reads every page, survives a redeploy mid-run, and reports bonds it cannot use', async () => {
    const { fetchBondScannerBonds } = await import('../src/providers/bondscannerSite');
    const r = await fetchBondScannerBonds({ fetch: fakeFetch, delayMs: 0, api: 'https://api.test', site: 'https://site.test' });
    expect(r.listed).toBe(3);
    expect(r.bonds.map((b) => b.isin)).toEqual(['INE583D08081', 'INE134E07ED4']);
    expect(r.problems).toEqual([{ isin: 'INE0LN107105', message: 'no face value' }]);
    expect(calls.filter((u) => u.endsWith('/bonds'))).toHaveLength(2); // build id re-read once after the redeploy
    expect(r.bonds[0]).toMatchObject({
      name: 'UGRO Capital Mar ’31', issuer: 'UGRO Capital', faceValue: 100000, couponRate: 11.65, frequency: 12, couponType: 'fixed',
      issueDate: '2026-03-15', maturityDate: '2031-03-15', rating: 'A+', ratingAgency: 'India Ratings', source: 'bondscanner', externalId: 'D1',
      // Listed payouts, plus the monthly coupons since the issue date (15 Apr to 15 Nov 2026) added in front.
      cashflows: expect.arrayContaining([{ date: '2026-04-15', interest: 970.83, principal: 0 }, { date: '2026-11-15', interest: 970.83, principal: 0 }, { date: '2026-12-15', interest: 957.53, principal: 0 }, { date: '2031-03-15', interest: 893.7, principal: 100000 }]),
    });
    expect(r.bonds[1]).toMatchObject({ frequency: 4, couponRate: 5.25 });

    // Saved, the bond uses the issuer's schedule for payouts.
    await c.directory.save(r.bonds, 'bondscanner.com');
    const t = (await c.bonds.getMany(['INE583D08081'])).get('INE583D08081')!;
    expect(t).toMatchObject({ source: 'bondscanner' });
    expect(t.cashflows!.map((f: any) => f.date)).toEqual(['2026-04-15', '2026-05-15', '2026-06-15', '2026-07-15', '2026-08-15', '2026-09-15', '2026-10-15', '2026-11-15', '2026-12-15', '2031-03-15']);
    const listed = (await c.directory.list()).find((b) => b.isin === 'INE583D08081')!;
    expect(listed).toMatchObject({ source: 'bondscanner', externalId: 'D1', note: 'BondScanner · Subordinate Tier 2' });
  });
});

describe('Expected yield with bonds that have no yield', () => {
  it('leaves a bond without a yield out of the average instead of counting it as 0%', async () => {
    const U3 = { 'x-user-id': 'test-user-yield', 'x-eh-today': TODAY };
    await app.inject({ method: 'POST', url: `${P}/consent`, headers: U3 });
    const rows = [
      { isin: 'INE0UNK07017', units: 1, investedAmount: 10000, acquiredOn: '2026-10-01', purchaseYield: 12 },
      { isin: 'INE0XYZ07016', units: 1, investedAmount: 90000, acquiredOn: '2026-10-01' }, // no yield
    ];
    const m = (await app.inject({ method: 'POST', url: `${P}/imports/manual`, headers: U3, payload: { rows } })).json();
    const valid = m.rows.filter((r: any) => r.status === 'awaiting');
    await app.inject({ method: 'POST', url: `${P}/imports/${m.importId}/commit`, headers: U3, payload: { mode: 'new', rows: valid.map((r: any) => ({ isin: r.isin, units: r.units, investedAmount: r.investedAmount, acquiredOn: r.acquiredOn, purchaseYield: r.purchaseYield, notify: true })), ownership: { kind: 'self' } } });
    const o = (await app.inject({ method: 'GET', url: `${P}/overview?scope=all`, headers: U3 })).json();
    expect(o.awaiting).toHaveLength(2); // both saved; one has no yield
    expect(o.summary.invested).toBe(100000);
    expect(o.summary.avgCoupon).toBe(12);
  });
});

describe('Same bond bought on different dates', () => {
  it('keeps each date as its own row; template uploads add rows or replace a bond', async () => {
    const U4 = { 'x-user-id': 'test-user-lots', 'x-eh-today': TODAY };
    await app.inject({ method: 'POST', url: `${P}/consent`, headers: U4 });
    const isin = 'INE0UNK07017';
    const save = async (rows: { units: number; investedAmount: number; acquiredOn: string }[], extra: Record<string, unknown>) => {
      const m = (await app.inject({ method: 'POST', url: `${P}/imports/manual`, headers: U4, payload: { rows: rows.map((r) => ({ isin, purchaseYield: 10, ...r })) } })).json();
      expect(m.rows).toHaveLength(rows.length);
      const res = await app.inject({ method: 'POST', url: `${P}/imports/${m.importId}/commit`, headers: U4, payload: { ...extra, rows: m.rows.map((r: any) => ({ isin: r.isin, units: r.units, investedAmount: r.investedAmount, acquiredOn: r.acquiredOn, purchaseYield: r.purchaseYield, notify: true })), ownership: { kind: 'self' } } });
      expect(res.statusCode).toBe(200);
      return res.json();
    };
    const overview = async () => (await app.inject({ method: 'GET', url: `${P}/overview?scope=all`, headers: U4 })).json();

    const first = await save([{ units: 1, investedAmount: 10000, acquiredOn: '2026-09-01' }, { units: 2, investedAmount: 20000, acquiredOn: '2026-10-01' }], { mode: 'new' });
    let o = await overview();
    expect(o.awaiting.map((a: any) => [a.units, a.investedOn]).sort()).toEqual([[1, '2026-09-01'], [2, '2026-10-01']]);
    expect(o.summary.invested).toBe(30000);

    // Uploading again with only the October purchase (updated) removes the September one.
    await save([{ units: 3, investedAmount: 30000, acquiredOn: '2026-10-01' }], { mode: 'replace', portfolioId: first.portfolioId });
    o = await overview();
    expect(o.awaiting.map((a: any) => [a.units, a.investedOn])).toEqual([[3, '2026-10-01']]);

    // Template upload (append): "Add" keeps what is saved and adds the file's rows, even on the same date.
    await save([{ units: 1, investedAmount: 10000, acquiredOn: '2026-10-01' }], { mode: 'append' });
    o = await overview();
    expect(o.portfolios).toHaveLength(1);
    expect(o.awaiting.map((a: any) => [a.units, a.investedOn]).sort()).toEqual([[1, '2026-10-01'], [3, '2026-10-01']]);
    // "Replace" removes only the saved rows with the same ISIN and date; other dates stay.
    await save([{ units: 5, investedAmount: 50000, acquiredOn: '2026-10-01' }], { mode: 'append', replaceLots: [{ isin, acquiredOn: '2026-10-01' }] });
    o = await overview();
    expect(o.awaiting.map((a: any) => [a.units, a.investedOn])).toEqual([[5, '2026-10-01']]);
    await save([{ units: 2, investedAmount: 20000, acquiredOn: '2026-08-01' }, { units: 6, investedAmount: 60000, acquiredOn: '2026-10-01' }], { mode: 'append', replaceLots: [{ isin, acquiredOn: '2026-10-01' }] });
    o = await overview();
    expect(o.awaiting.map((a: any) => [a.units, a.investedOn]).sort()).toEqual([[2, '2026-08-01'], [6, '2026-10-01']]);
    expect(o.summary.invested).toBe(80000);
  });

  it('append with no holding yet creates "My holdings"', async () => {
    const U5 = { 'x-user-id': 'test-user-append', 'x-eh-today': TODAY };
    await app.inject({ method: 'POST', url: `${P}/consent`, headers: U5 });
    const m = (await app.inject({ method: 'POST', url: `${P}/imports/manual`, headers: U5, payload: { rows: [{ isin: 'INE0UNK07017', units: 2, investedAmount: 2000, acquiredOn: '2026-10-01', purchaseYield: 9 }] } })).json();
    const res = await app.inject({ method: 'POST', url: `${P}/imports/${m.importId}/commit`, headers: U5, payload: { mode: 'append', rows: m.rows.map((r: any) => ({ isin: r.isin, units: r.units, investedAmount: r.investedAmount, acquiredOn: r.acquiredOn, purchaseYield: r.purchaseYield, notify: true })), ownership: { kind: 'self' } } });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Holding 1');
  });
});

describe('Who is using the tool (name + email)', () => {
  it('asks once, saves the person, logs sign-up and visits, and shows them in the admin views', async () => {
    const U6 = { 'x-user-id': 'test-user-profile', 'x-eh-today': TODAY };
    expect((await app.inject({ method: 'GET', url: `${P}/profile`, headers: U6 })).json().profile).toBeNull();
    const bad = await app.inject({ method: 'POST', url: `${P}/profile`, headers: U6, payload: { name: 'A', email: 'not-an-email' } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: `${P}/profile`, headers: U6, payload: { name: ' Asha Rao ', email: 'Asha@Example.com ' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().profile).toEqual({ name: 'Asha Rao', email: 'asha@example.com' });
    expect((await app.inject({ method: 'GET', url: `${P}/profile`, headers: U6 })).json().profile).toEqual({ name: 'Asha Rao', email: 'asha@example.com' });
    const users = await c.db.query<any>(`SELECT name, email, isins FROM eh_admin.users WHERE user_id=$1`, ['test-user-profile']);
    expect(users).toEqual([{ name: 'Asha Rao', email: 'asha@example.com', isins: 0 }]);
    const acts = await c.db.query<any>(`SELECT event FROM eh_admin.activity WHERE user_id=$1`, ['test-user-profile']);
    expect(acts.map((a: any) => a.event)).toContain('eh_signed_up');
    const days = await c.db.query<any>(`SELECT sign_ups FROM eh_admin.daily_usage`);
    expect(days.length).toBeGreaterThan(0);
  });
});

describe('Admin: feature adoption', () => {
  it('records funnel steps and reports them only with the admin key', async () => {
    const U7 = { 'x-user-id': 'test-user-funnel', 'x-eh-today': TODAY };
    await app.inject({ method: 'POST', url: `${P}/profile`, headers: U7, payload: { name: 'Ravi K', email: 'ravi@example.com' } });
    expect((await app.inject({ method: 'POST', url: `${P}/events`, headers: U7, payload: { name: 'eh_add_opened' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `${P}/events`, headers: U7, payload: { name: 'eh_template_downloaded', props: { format: 'xlsx' } } })).statusCode).toBe(200);
    // Only known steps are accepted.
    expect((await app.inject({ method: 'POST', url: `${P}/events`, headers: U7, payload: { name: 'eh_anything' } })).statusCode).toBe(400);
    await app.inject({ method: 'POST', url: `${P}/consent`, headers: U7 });
    const m = (await app.inject({ method: 'POST', url: `${P}/imports/manual`, headers: U7, payload: { rows: [{ isin: 'INE0UNK07017', units: 1, investedAmount: 1000, acquiredOn: '2026-10-01', purchaseYield: 9 }] } })).json();
    await app.inject({ method: 'POST', url: `${P}/imports/${m.importId}/commit`, headers: U7, payload: { mode: 'append', rows: m.rows.map((r: any) => ({ isin: r.isin, units: r.units, investedAmount: r.investedAmount, acquiredOn: r.acquiredOn, purchaseYield: r.purchaseYield, notify: true })), ownership: { kind: 'self' } } });

    (config as any).adminToken = 'test-admin';
    try {
      expect((await app.inject({ method: 'GET', url: `${P}/admin/stats` })).statusCode).toBe(401);
      const s = (await app.inject({ method: 'GET', url: `${P}/admin/stats?days=7`, headers: { 'x-admin-token': 'test-admin' } })).json();
      expect(s.days).toBe(7);
      const step = (l: string) => s.funnel.find((f: any) => f.label === l).users;
      expect(step('Visited')).toBeGreaterThanOrEqual(1);
      for (const l of ['Opened the upload page', 'Downloaded the template', 'Uploaded a file', 'Saved holdings', 'Still has holdings']) expect(step(l)).toBeGreaterThanOrEqual(1);
      const ravi = s.users.find((u: any) => u.email === 'ravi@example.com');
      expect(ravi).toMatchObject({ name: 'Ravi K', isins: 1, invested: 1000, uploads: 1 });
      // Anonymous visitors (no name) are counted too.
      await app.inject({ method: 'GET', url: `${P}/profile`, headers: { 'x-user-id': 'anon-visitor-1', 'x-eh-today': TODAY } });
      const s2 = (await app.inject({ method: 'GET', url: `${P}/admin/stats`, headers: { 'x-admin-token': 'test-admin' } })).json();
      expect(s2.users.find((u: any) => u.id === 'anon-visitor-1')).toMatchObject({ name: null, visits: 1 });
      expect(s2.totals.visitors).toBeGreaterThan(s.totals.visitors - 1);
      expect(s.recent.some((r: any) => r.event === 'eh_template_downloaded' && r.email === 'ravi@example.com')).toBe(true);
      expect(s.daily.length).toBeGreaterThan(0);
      expect(s.totals.with_holdings).toBeGreaterThanOrEqual(1);
    } finally {
      (config as any).adminToken = '';
    }
  });
});

describe('Inside bondscanner.com (gateway)', () => {
  it('knows the logged-in user from the gateway headers, with no form', async () => {
    (config as any).gatewaySecret = 'gw-secret';
    try {
      const H = { 'x-user-id': 'bs-user-42', 'x-gateway-secret': 'gw-secret', 'x-user-name': 'Meera Iyer', 'x-user-email': 'Meera@Example.com', 'x-eh-today': TODAY };
      const r = await app.inject({ method: 'GET', url: `${P}/profile`, headers: H });
      expect(r.json().profile).toEqual({ name: 'Meera Iyer', email: 'meera@example.com' });
      // Spoofed headers without the gateway secret are refused.
      const spoof = await app.inject({ method: 'GET', url: `${P}/profile`, headers: { ...H, 'x-gateway-secret': 'wrong' } });
      expect(spoof.statusCode).toBe(401);
    } finally {
      (config as any).gatewaySecret = undefined;
    }
  });
});

describe('Several holdings (tabs)', () => {
  it('saves into a new holding, into a chosen one, and renames it', async () => {
    const U8 = { 'x-user-id': 'test-user-tabs', 'x-eh-today': TODAY };
    await app.inject({ method: 'POST', url: `${P}/consent`, headers: U8 });
    const save = async (isin: string, extra: Record<string, unknown>) => {
      const m = (await app.inject({ method: 'POST', url: `${P}/imports/manual`, headers: U8, payload: { rows: [{ isin, units: 1, investedAmount: 1000, acquiredOn: '2026-10-01', purchaseYield: 9 }] } })).json();
      const r = await app.inject({ method: 'POST', url: `${P}/imports/${m.importId}/commit`, headers: U8, payload: { mode: 'append', rows: m.rows.map((x: any) => ({ isin: x.isin, units: x.units, investedAmount: x.investedAmount, acquiredOn: x.acquiredOn, purchaseYield: x.purchaseYield, notify: true })), ownership: { kind: 'self' }, ...extra } });
      expect(r.statusCode).toBe(200);
      return r.json();
    };
    const first = await save('INE0UNK07017', {});
    expect(first.name).toBe('Holding 1');
    const second = await save('INE0XYZ07016', { newHolding: true });
    expect(second.name).toBe('Holding 2');
    expect(second.portfolioId).not.toBe(first.portfolioId);
    await save('INE0UNK07017', { portfolioId: second.portfolioId });
    const o = (await app.inject({ method: 'GET', url: `${P}/overview?scope=all`, headers: U8 })).json();
    expect(o.portfolios.map((p: any) => p.name)).toEqual(['Holding 1', 'Holding 2']);
    expect(o.awaiting.filter((a: any) => a.portfolioId === second.portfolioId)).toHaveLength(2);
    expect(o.awaiting.filter((a: any) => a.portfolioId === first.portfolioId)).toHaveLength(1);
    const ren = await app.inject({ method: 'PATCH', url: `${P}/portfolios/${second.portfolioId}`, headers: U8, payload: { name: 'Zerodha bonds' } });
    expect(ren.statusCode).toBe(200);
    const o2 = (await app.inject({ method: 'GET', url: `${P}/overview?scope=all`, headers: U8 })).json();
    expect(o2.portfolios.map((p: any) => p.name)).toContain('Zerodha bonds');
  });
});

describe('Issuer name and "send any format"', () => {
  it('stores the issuer name the user gives and shows it for bonds not in our data', async () => {
    const U9 = { 'x-user-id': 'test-user-issuer', 'x-eh-today': TODAY };
    await app.inject({ method: 'POST', url: `${P}/consent`, headers: U9 });
    const m = (await app.inject({ method: 'POST', url: `${P}/imports/manual`, headers: U9, payload: { rows: [{ isin: 'INE0UNK07017', nameHint: 'Acme Finance Ltd', units: 1, investedAmount: 1000, acquiredOn: '2026-10-01', purchaseYield: 9 }] } })).json();
    expect(m.rows[0].nameHint).toBe('Acme Finance Ltd');
    await app.inject({ method: 'POST', url: `${P}/imports/${m.importId}/commit`, headers: U9, payload: { mode: 'append', rows: m.rows.map((r: any) => ({ isin: r.isin, units: r.units, investedAmount: r.investedAmount, acquiredOn: r.acquiredOn, purchaseYield: r.purchaseYield, issuerName: r.nameHint, notify: true })), ownership: { kind: 'self' } } });
    let o = (await app.inject({ method: 'GET', url: `${P}/overview?scope=all`, headers: U9 })).json();
    expect(o.awaiting[0]).toMatchObject({ name: 'Acme Finance Ltd', issuerName: 'Acme Finance Ltd' });
    // Editing keeps or changes the issuer name.
    await app.inject({ method: 'PUT', url: `${P}/holdings/${o.awaiting[0].id}/investment`, headers: U9, payload: { units: 2, acquiredOn: '2026-10-01', investedAmount: 2000, purchaseYield: 9, issuerName: 'Acme Finance Limited' } });
    o = (await app.inject({ method: 'GET', url: `${P}/overview?scope=all`, headers: U9 })).json();
    expect(o.awaiting[0]).toMatchObject({ name: 'Acme Finance Limited', units: 2 });
  });

  it('takes a file in any format, shows the visitor its status, and lets the admin download it and mark it added', async () => {
    const U10 = { 'x-user-id': 'test-user-assisted', 'x-eh-today': TODAY };
    const pdf = { name: 'Zerodha statement.pdf', mime: 'application/pdf', data: new TextEncoder().encode('%PDF-1.4 fake') };
    // Without the T&C tick the file is refused.
    const noConsent = await app.inject({ method: 'POST', url: `${P}/assisted`, ...multipart([pdf], {}, U10) });
    expect(noConsent.statusCode).toBe(403);
    expect(noConsent.json().error).toBe('consent_required');
    await app.inject({ method: 'POST', url: `${P}/consent`, headers: U10 });
    const sent = await app.inject({ method: 'POST', url: `${P}/assisted`, ...multipart([pdf], { note: 'Password is my PAN' }, U10) });
    expect(sent.statusCode).toBe(200);
    let mine = (await app.inject({ method: 'GET', url: `${P}/assisted`, headers: U10 })).json().requests;
    expect(mine).toEqual([expect.objectContaining({ fileName: 'Zerodha statement.pdf', status: 'received' })]);
    // Another visitor does not see it.
    expect((await app.inject({ method: 'GET', url: `${P}/assisted`, headers: { 'x-user-id': 'someone-else' } })).json().requests).toEqual([]);

    (config as any).adminToken = 'test-admin';
    try {
      const A = { 'x-admin-token': 'test-admin' };
      expect((await app.inject({ method: 'GET', url: `${P}/admin/assisted` })).statusCode).toBe(401);
      const list = (await app.inject({ method: 'GET', url: `${P}/admin/assisted`, headers: A })).json().requests;
      const req = list.find((r: any) => r.userId === 'test-user-assisted');
      expect(req).toMatchObject({ fileName: 'Zerodha statement.pdf', note: 'Password is my PAN', status: 'received' });
      const file = await app.inject({ method: 'GET', url: `${P}/admin/assisted/${req.id}/file`, headers: A });
      expect(file.statusCode).toBe(200);
      expect(file.headers['content-disposition']).toContain('Zerodha statement.pdf');
      expect(file.rawPayload.toString()).toBe('%PDF-1.4 fake');
      expect((await app.inject({ method: 'POST', url: `${P}/admin/assisted/${req.id}/done`, headers: A, payload: { done: true } })).statusCode).toBe(200);
      mine = (await app.inject({ method: 'GET', url: `${P}/assisted`, headers: U10 })).json().requests;
      expect(mine[0].status).toBe('done');
    } finally {
      (config as any).adminToken = '';
    }
  });
});

describe('Team alert when a visitor sends a file', () => {
  it('posts to Slack and sends an email when configured, with a link to the admin page and no file attached', async () => {
    const calls: { url: string; body: any; auth?: string }[] = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(init.body), auth: init.headers?.authorization });
      return new Response('ok', { status: 200 });
    });
    const keep = { ...process.env };
    process.env.ALERT_SLACK_WEBHOOK_URL = 'https://hooks.slack.test/T/B/X';
    process.env.RESEND_API_KEY = 're_test';
    process.env.ALERT_EMAIL_TO = 'ops@example.com, pm@example.com';
    try {
      const U11 = { 'x-user-id': 'test-user-alert' };
      await app.inject({ method: 'POST', url: `${P}/consent`, headers: U11 });
      const res = await app.inject({ method: 'POST', url: `${P}/assisted`, ...multipart([{ name: 'HDFC statement.pdf', mime: 'application/pdf', data: new TextEncoder().encode('%PDF x') }], { note: 'Two bonds' }, U11) });
      expect(res.statusCode).toBe(200);
      const slack = calls.find((c) => c.url.startsWith('https://hooks.slack.test'));
      expect(slack?.body.text).toContain('New file to add: HDFC statement.pdf');
      expect(slack?.body.text).toContain('Note: Two bonds');
      expect(slack?.body.text).toContain('/bond-portfolio/admin');
      const mail = calls.find((c) => c.url === 'https://api.resend.com/emails');
      expect(mail?.auth).toBe('Bearer re_test');
      expect(mail?.body).toMatchObject({ to: ['ops@example.com', 'pm@example.com'], subject: 'New file to add: HDFC statement.pdf' });
      expect(JSON.stringify(mail?.body)).not.toContain('%PDF');
    } finally {
      process.env = keep;
      spy.mockRestore();
    }
  });

  it('still accepts the file when the alert fails, and sends nothing when not configured', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const keep = { ...process.env };
    process.env.ALERT_SLACK_WEBHOOK_URL = 'https://hooks.slack.test/T/B/X';
    try {
      await app.inject({ method: 'POST', url: `${P}/consent`, headers: { 'x-user-id': 'test-user-alert2' } });
      const res = await app.inject({ method: 'POST', url: `${P}/assisted`, ...multipart([{ name: 'a.png', mime: 'image/png', data: new Uint8Array([1, 2, 3]) }], {}, { 'x-user-id': 'test-user-alert2' }) });
      expect(res.statusCode).toBe(200);
      delete process.env.ALERT_SLACK_WEBHOOK_URL;
      spy.mockClear();
      await app.inject({ method: 'POST', url: `${P}/assisted`, ...multipart([{ name: 'b.png', mime: 'image/png', data: new Uint8Array([1]) }], {}, { 'x-user-id': 'test-user-alert2' }) });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      process.env = keep;
      spy.mockRestore();
    }
  });
});

describe('Button click tracking', () => {
  it('records clicks by button id and shows counts per button on the admin stats', async () => {
    const U12 = { 'x-user-id': 'test-user-clicks' };
    for (const target of ['add_holdings_table', 'add_holdings_table', 'add_popup_manual'])
      expect((await app.inject({ method: 'POST', url: `${P}/events`, headers: U12, payload: { name: 'eh_click', props: { target } } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `${P}/events`, headers: U12, payload: { name: 'eh_click', props: { target: '<script>' } } })).statusCode).toBe(400);
    (config as any).adminToken = 'test-admin';
    try {
      const s = (await app.inject({ method: 'GET', url: `${P}/admin/stats?days=7`, headers: { 'x-admin-token': 'test-admin' } })).json();
      expect(s.clicks.find((c: any) => c.target === 'add_holdings_table')).toMatchObject({ clicks: 2, people: 1 });
      expect(s.clicks.find((c: any) => c.target === 'add_popup_manual')).toMatchObject({ clicks: 1, people: 1 });
    } finally {
      (config as any).adminToken = '';
    }
  });
});

describe('Team adds holdings for a visitor, then deletes the file', () => {
  it('saves the bonds into that visitor, marks the request added, and frees the file', async () => {
    const V = { 'x-user-id': 'test-user-assisted-add', 'x-eh-today': TODAY };
    await app.inject({ method: 'POST', url: `${P}/consent`, headers: V });
    const sent = (await app.inject({ method: 'POST', url: `${P}/assisted`, ...multipart([{ name: 'ICICI statement.pdf', mime: 'application/pdf', data: new TextEncoder().encode('%PDF x') }], {}, V) })).json();
    (config as any).adminToken = 'test-admin';
    const A = { 'x-admin-token': 'test-admin', 'x-eh-today': TODAY };
    try {
      // Only with the admin key, and a bad ISIN is refused.
      expect((await app.inject({ method: 'POST', url: `${P}/admin/assisted/${sent.id}/holdings`, payload: { rows: [] } })).statusCode).toBe(401);
      const bad = await app.inject({ method: 'POST', url: `${P}/admin/assisted/${sent.id}/holdings`, headers: A, payload: { rows: [{ isin: 'INE0UNK07018', issuerName: 'Acme', units: 1, investedAmount: 1000, acquiredOn: '2026-10-01', purchaseYield: 9 }] } });
      expect(bad.statusCode).toBe(400);
      const ok = await app.inject({
        method: 'POST',
        url: `${P}/admin/assisted/${sent.id}/holdings`,
        headers: A,
        payload: { rows: [{ isin: 'INE0UNK07017', issuerName: 'Acme Finance Limited', units: 3, investedAmount: 30000, acquiredOn: '2026-10-01', purchaseYield: 10.5 }] },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ added: 1, holding: 'Holding 1' });
      const o = (await app.inject({ method: 'GET', url: `${P}/overview?scope=all`, headers: V })).json();
      expect(o.awaiting[0]).toMatchObject({ isin: 'INE0UNK07017', name: 'Acme Finance Limited', units: 3, investedAmount: 30000 });
      const mine = (await app.inject({ method: 'GET', url: `${P}/assisted`, headers: V })).json().requests;
      expect(mine[0].status).toBe('done');

      // Delete the file: gone from storage, request kept.
      expect((await app.inject({ method: 'DELETE', url: `${P}/admin/assisted/${sent.id}/file`, headers: A })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: `${P}/admin/assisted/${sent.id}/file`, headers: A })).statusCode).toBe(410);
      const row = (await app.inject({ method: 'GET', url: `${P}/admin/assisted`, headers: A })).json().requests.find((r: any) => r.id === sent.id);
      expect(row).toMatchObject({ hasFile: false, status: 'done', rowsAdded: 1, fileName: 'ICICI statement.pdf' });
      const stored = await c.db.query<any>(`SELECT data IS NULL AS gone FROM eh_assisted_uploads WHERE id=$1`, [sent.id]);
      expect(stored[0].gone).toBe(true);
    } finally {
      (config as any).adminToken = '';
    }
  });
});

import { backfillCoupons } from '../src/providers/bondscannerSite';
describe('BondScanner directory sync', () => {
  it('adds the coupons paid before the first listed payout, back to the issue date', () => {
    const flows = [
      { date: '2027-01-12', interest: 1019.2, principal: 0 },
      { date: '2027-02-12', interest: 1019.2, principal: 0 },
    ];
    const out = backfillCoupons(flows, { frequency: 12, couponRate: 12, faceValue: 100000, issueDate: '2026-09-15' });
    expect(out.map((f) => f.date)).toEqual(['2026-10-12', '2026-11-12', '2026-12-12', '2027-01-12', '2027-02-12']);
    expect(out[0]).toEqual({ date: '2026-10-12', interest: 1000, principal: 0 });
    // Month-end dates are clamped; zero-coupon bonds are left alone.
    expect(backfillCoupons([{ date: '2027-03-31', interest: 10, principal: 0 }], { frequency: 4, couponRate: 8, faceValue: 1000, issueDate: '2026-08-01' }).map((f) => f.date)).toEqual(['2026-09-30', '2026-12-31', '2027-03-31']);
    expect(backfillCoupons(flows, { frequency: 0, couponRate: 0, faceValue: 1000 })).toBe(flows);
  });
});

describe('Daily directory refresh (Vercel Cron)', () => {
  it('runs only with the cron secret', async () => {
    const keep = process.env.CRON_SECRET;
    try {
      delete process.env.CRON_SECRET;
      expect((await app.inject({ method: 'GET', url: `${P}/cron/sync-bondscanner` })).statusCode).toBe(404);
      process.env.CRON_SECRET = 'test-cron';
      expect((await app.inject({ method: 'GET', url: `${P}/cron/sync-bondscanner` })).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url: `${P}/cron/sync-bondscanner`, headers: { authorization: 'Bearer wrong-one' } })).statusCode).toBe(401);
    } finally {
      if (keep === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = keep;
    }
  });
});
