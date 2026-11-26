import { useMemo, useState } from 'react';
import { formatDate, formatDateNumeric, FREQUENCY_LABEL, inr, MONTHS_SHORT, pct } from '@eh/core';
import { SubHead, useApp, useLoad } from '../app';
import type { HoldingDto, Overview, Payout, PortfolioDto } from '../api/types';
import { Icon, Sheet, Skeleton } from '../ui';

/**
 * Portfolio report for External Holdings, laid out like BondScanner's family portfolio report:
 * header bar (holding picker + email / download / help), four summary cards, three donuts
 * (by holding, sector, rating), stacked payout chart, and a per-holding breakdown.
 */

/** Series colours, in the order the family report uses them. */
const SERIES = ['#3B82F6', '#14B8A6', '#F59E0B', '#A855F7', '#10B981', '#EC4899', '#64748B'];
const SECTOR = ['#1D4ED8', '#0D9488', '#A855F7', '#F59E0B', '#EC4899', '#64748B'];
const GRADE: Record<string, string> = {
  AAA: '#1C398E', 'AA+': '#065F46', AA: '#047857', 'AA-': '#059669', 'A+': '#10B981', A: '#34D399', 'A-': '#6EE7B7',
  'BBB+': '#92400E', BBB: '#B45309', 'BBB-': '#D97706', Unrated: '#94A3B8',
};
const gradeColor = (g: string) => GRADE[g] ?? '#DC2626';
const initial = (s: string) => (s.trim()[0] ?? '?').toUpperCase();

export function ReportScreen() {
  const { api, go } = useApp();
  const [scope, setScope] = useState('all');
  const [picker, setPicker] = useState(false);
  const [dl, setDl] = useState(false);
  const all = useLoad(() => api.overview('all'), []);
  const ov = useLoad(() => api.overview(scope), [scope]);
  const rep = useLoad(() => api.report(scope), [scope]);
  const pays = useLoad(() => api.payouts({ scope }), [scope]);
  const d = ov.data;
  const portfolios = all.data?.portfolios ?? [];

  if (!d || !rep.data || !pays.data || !all.data)
    return (
      <>
        <SubHead title="Portfolio report" onBack={() => go({ name: 'external' })} />
        <div className="bs-page">
          <Skeleton h={60} />
          <Skeleton h={180} />
          <Skeleton h={240} />
        </div>
      </>
    );

  const s = d.summary;
  const today = d.today;
  const shown = scope === 'all' ? portfolios : portfolios.filter((p) => p.id === scope);
  const colorOf = (pid: string) => SERIES[Math.max(0, portfolios.findIndex((p) => p.id === pid)) % SERIES.length];
  const future = pays.data.payouts.filter((e) => e.date >= today);
  const byHolding = shown.map((p) => {
    const hs = d.holdings.filter((h) => h.portfolioId === p.id && !h.matured);
    const principal = hs.reduce((a, h) => a + h.principal, 0);
    const returns = future.filter((e) => e.portfolioId === p.id).reduce((a, e) => a + e.interest, 0);
    const yld = principal ? hs.reduce((a, h) => a + h.couponRate * h.principal, 0) / principal : 0;
    return { p, hs, principal, returns, yld };
  });
  const totalP = byHolding.reduce((a, x) => a + x.principal, 0) || 1;
  const m = Number(today.slice(5, 7)) - 1;
  // With one holding, "by holding" says nothing: show issuers instead.
  const byH = scope === 'all' && byHolding.length > 1;

  return (
    <>
      <div className="noprint">
        <SubHead title="Overview of your external portfolio" onBack={() => go({ name: 'external' })} big />
      </div>
      <div className="bs-page rp" id="report">
        <p className="tiny-note">Includes only bonds added from other platforms. Bonds bought on BondScanner are not included.</p>
        <span className="print-only rp-print-head">BondScanner · External holdings report · as on {formatDateNumeric(today)}</span>

        {/* Header bar: holding picker + actions */}
        <div className="rp-bar">
          {portfolios.length > 1 ? (
            <button className="rp-pick" onClick={() => setPicker(true)} aria-haspopup="dialog">
              <b>{scope === 'all' ? `All external holdings (${portfolios.length})` : portfolios.find((p) => p.id === scope)?.name}</b>
              <Icon name="arrow-down-s-line" size={18} />
            </button>
          ) : (
            <span className="rp-pick">
              <b>All external holdings (1)</b>
            </span>
          )}
          <span className="rp-avatars" aria-hidden="true">
            {portfolios.slice(0, 3).map((p) => (
              <i key={p.id}>{initial(p.ownerLabel ?? p.name)}</i>
            ))}
            {portfolios.length > 3 && <i>+{portfolios.length - 3}</i>}
          </span>
          <span className="rp-actions noprint">
            <button aria-label="Email this report" onClick={() => share(d, today)}>
              <Icon name="mail-line" size={20} />
            </button>
            <button aria-label="Download report" onClick={() => setDl(true)}>
              <Icon name="download-2-line" size={20} />
            </button>
            <button aria-label="Help" onClick={() => go({ name: 'external' })}>
              <Icon name="customer-service-2-line" size={20} />
            </button>
          </span>
        </div>

        {rep.data.flags.map((f) => (
          <div className="warnb" key={f}>
            {f}
          </div>
        ))}

        {/* Summary cards */}
        <div className="rp-stats">
          <Stat label="Active principal" info="Face value of bonds you still hold" value={inr(s.principal)} sub={`Across ${shown.length} ${shown.length === 1 ? 'holding' : 'holdings'}`} />
          <Stat label={`Interest · ${MONTHS_SHORT[m]} ’${today.slice(2, 4)}`} info="Interest due this month, before tax" value={inr(s.interestThisMonth)} sub="This month" />
          <Stat label="Expected returns" info="All interest still to come, till maturity, before tax" value={inr(s.expectedInterest)} sub="Till maturity" />
          <Stat label="Expected yield" info="Average coupon, weighted by principal" value={s.holdingsCount ? pct(s.avgCoupon) : '–'} sub="Annualised yield" green />
        </div>

        {/* Donuts */}
        <div className="rp-donuts">
          <DonutCard
            title={byH ? 'Portfolio by holding' : 'Portfolio by issuer'}
            info="Share of active principal"
            center={byH ? byHolding.length : rep.data.issuers.length}
            centerLabel={byH ? 'Holdings' : rep.data.issuers.length === 1 ? 'Issuer' : 'Issuers'}
            items={
              byH
                ? byHolding.map((x) => ({ label: x.p.name, share: x.principal / totalP, color: colorOf(x.p.id) }))
                : rep.data.issuers.map((x, i) => ({ label: x.issuer, share: x.share, color: SERIES[i % SERIES.length] }))
            }
          />
          <DonutCard
            title="Portfolio by sector"
            info="Issuer sector, from exchange data"
            center={rep.data.sectorMix.length}
            centerLabel={rep.data.sectorMix.length === 1 ? 'Sector' : 'Sectors'}
            items={rep.data.sectorMix.map((x, i) => ({ label: x.sector, share: x.share, color: SECTOR[i % SECTOR.length] }))}
          />
          <DonutCard
            title="Portfolio by rating"
            info="Credit rating of each bond"
            center={rep.data.gradeMix.length}
            centerLabel={rep.data.gradeMix.length === 1 ? 'Grade' : 'Grades'}
            items={rep.data.gradeMix.map((x) => ({ label: x.grade, share: x.share, color: gradeColor(x.grade) }))}
          />
        </div>

        <PayoutChart events={pays.data.payouts} today={today} series={shown.map((p) => ({ id: p.id, name: p.name, color: colorOf(p.id) }))} />

        <Breakdown rows={byHolding} future={future} colorOf={colorOf} />

        <p className="bs-note">
          <b>Disclaimer:</b> External holdings are based on the files or details you added and may not match your demat account exactly. Interest is paid only to whoever holds the bond on the record date set by the issuer. Amounts are before tax. Not investment advice.
        </p>
      </div>

      {picker && (
        <Sheet onClose={() => setPicker(false)} label="Choose holding">
          <h3 className="h-card">Show report for</h3>
          <p className="p small muted">Includes only bonds added from other platforms. Bonds bought on BondScanner appear under Holdings.</p>
          {[{ id: 'all', name: `All external holdings (${portfolios.length})` } as Pick<PortfolioDto, 'id' | 'name'>, ...portfolios].map((p) => (
            <button key={p.id} className={`btn btn-block ${scope === p.id ? 'btn-primary' : 'btn-ghost'}`} onClick={() => (setScope(p.id), setPicker(false))}>
              {p.name}
            </button>
          ))}
        </Sheet>
      )}
      {dl && (
        <Sheet onClose={() => setDl(false)} label="Download report">
          <h3 className="h-card">Download report</h3>
          <button className="btn btn-primary btn-block" onClick={() => (setDl(false), setTimeout(() => window.print(), 50))}>
            <Icon name="file-pdf-2-line" size={18} /> PDF (print or save)
          </button>
          <button className="btn btn-outline btn-block" onClick={() => (downloadCsv(d, pays.data!.payouts, today), setDl(false))}>
            <Icon name="file-excel-2-line" size={18} /> Spreadsheet (CSV)
          </button>
        </Sheet>
      )}
    </>
  );
}

function Stat({ label, info, value, sub, green }: { label: string; info: string; value: string; sub: string; green?: boolean }) {
  return (
    <div className="rp-stat">
      <span className="l">
        {label}
        <span title={info} aria-label={info} role="img">
          <Icon name="information-line" size={14} />
        </span>
      </span>
      <b className={green ? 'green' : undefined}>{value}</b>
      <span className="s">{sub}</span>
    </div>
  );
}

function DonutCard({ title, info, center, centerLabel, items }: { title: string; info: string; center: number; centerLabel: string; items: { label: string; share: number; color: string }[] }) {
  const R = 38;
  const C = 2 * Math.PI * R;
  let acc = 0;
  return (
    <section className="rp-donut" aria-label={title}>
      <span className="l">
        {title}
        <span title={info} aria-label={info} role="img">
          <Icon name="information-line" size={14} />
        </span>
      </span>
      <div className="in">
        <svg viewBox="0 0 100 100" className="ring" role="img" aria-label={`${title}: ${items.map((i) => `${i.label} ${(i.share * 100).toFixed(1)}%`).join(', ')}`}>
          <circle cx="50" cy="50" r={R} fill="none" stroke="var(--bg-muted)" strokeWidth="14" />
          {items.map((it) => {
            const len = it.share * C;
            const el = (
              <circle key={it.label} cx="50" cy="50" r={R} fill="none" stroke={it.color} strokeWidth="14" strokeDasharray={`${Math.max(0, len - (items.length > 1 ? 0.8 : 0))} ${C}`} strokeDashoffset={-acc} transform="rotate(-90 50 50)" />
            );
            acc += len;
            return el;
          })}
          <text x="50" y="49" textAnchor="middle" className="big">
            {center}
          </text>
          <text x="50" y="61" textAnchor="middle" className="small">
            {centerLabel}
          </text>
        </svg>
        <ul>
          {items.map((it) => (
            <li key={it.label}>
              <i style={{ background: it.color }} />
              <span className="n">{it.label}</span>
              <span className="v">{fmtShare(it.share)}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

const fmtShare = (x: number) => {
  const v = x * 100;
  return `${v >= 10 ? v.toFixed(1).replace(/\.0$/, '') : v.toFixed(2).replace(/0$/, '')}%`;
};

export function PayoutChart({ events, today, series, title = 'Payouts by month', year: yearIn, onYear }: { events: Payout[]; today: string; series: { id: string; name: string; color: string }[]; title?: string | null; year?: number; onYear?: (y: number) => void }) {
  const [kind, setKind] = useState<'interest' | 'principal'>('interest');
  const years = [...new Set(events.map((e) => Number(e.date.slice(0, 4))))].sort();
  const [yearOwn, setYearOwn] = useState(Number(today.slice(0, 4)));
  const year = yearIn ?? yearOwn;
  const setYear = (y: number) => (onYear ? onYear(y) : setYearOwn(y));
  const [sel, setSel] = useState<number | null>(null);
  const data = useMemo(
    () =>
      Array.from({ length: 12 }, (_, i) => {
        const k = `${year}-${String(i + 1).padStart(2, '0')}`;
        const parts = series.map((s) => ({ ...s, v: events.filter((e) => e.portfolioId === s.id && e.date.startsWith(k)).reduce((a, e) => a + (kind === 'interest' ? e.interest : e.principal), 0) }));
        return { i, parts, total: parts.reduce((a, p) => a + p.v, 0) };
      }),
    [events, series, kind, year],
  );
  const max = niceMax(Math.max(...data.map((x) => x.total), 0));
  const ticks = [0, max / 4, max / 2, (3 * max) / 4, max];
  const active = sel != null ? data[sel] : null;

  return (
    <section className="bs-card rp-chart" aria-labelledby="pc-h">
      {title && (
        <h2 id="pc-h" className="bs-h2" style={{ margin: 0 }}>
          {title}
        </h2>
      )}
      <div className="bs-row" style={{ marginTop: title ? 14 : 0 }}>
        <span className="pills" role="group" aria-label="Show">
          <button aria-pressed={kind === 'interest'} onClick={() => setKind('interest')}>
            Interest
          </button>
          <button aria-pressed={kind === 'principal'} onClick={() => setKind('principal')}>
            Principal
          </button>
        </span>
        <label className="year-pill">
          <span className="sr-only">Year</span>
          <select value={year} onChange={(e) => (setYear(Number(e.target.value)), setSel(null))}>
            {(years.length ? (years.includes(year) ? years : [...years, year].sort()) : [year]).map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
          <Icon name="arrow-down-s-line" size={18} />
        </label>
      </div>
      <div className="plot">
        <div className="yaxis" aria-hidden="true">
          {[...ticks].reverse().map((t) => (
            <span key={t}>{short(t)}</span>
          ))}
        </div>
        <div className="cols">
          {data.map((x) => (
            <button key={x.i} className={`col ${sel === x.i ? 'sel' : ''}`} onClick={() => setSel(sel === x.i ? null : x.i)} onMouseEnter={() => setSel(x.i)} aria-label={`${MONTHS_SHORT[x.i]} ${year}: ${inr(Math.round(x.total))}`}>
              <span className="track">
                {x.parts.map((p) =>
                  p.v > 0 ? <i key={p.id} style={{ height: `${(p.v / max) * 100}%`, background: p.color }} /> : null,
                )}
              </span>
              <span className="m">
                <span className="full">{MONTHS_SHORT[x.i]}</span>
                <span className="ini" aria-hidden="true">
                  {MONTHS_SHORT[x.i][0]}
                </span>
              </span>
            </button>
          ))}
          {active && active.total > 0 && (
            <div className="tip" style={active.i < 6 ? { left: `${((active.i + 1) / 12) * 100}%` } : { right: `${((12 - active.i) / 12) * 100}%` }} role="status">
              <span className="t">
                {kind === 'interest' ? 'Interest' : 'Principal'} · {MONTHS_SHORT[active.i]} {year}
              </span>
              {active.parts
                .filter((p) => p.v > 0)
                .map((p) => (
                  <span key={p.id} className="r">
                    <i style={{ background: p.color }} />
                    {p.name}: <b>{inr(Math.round(p.v))}</b>
                  </span>
                ))}
            </div>
          )}
        </div>
      </div>
      {series.length > 1 && (
        <div className="legend" style={{ marginTop: 10 }}>
          {series.map((s) => (
            <span key={s.id}>
              <i style={{ background: s.color }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

const niceMax = (v: number) => {
  if (v <= 0) return 1000;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = [1, 2, 2.5, 4, 5, 8, 10].find((k) => k * p >= v)!;
  return n * p;
};
const short = (v: number) => (v >= 1e7 ? `${+(v / 1e7).toFixed(1)}Cr` : v >= 1e5 ? `${+(v / 1e5).toFixed(1)}L` : v >= 1000 ? `${+(v / 1000).toFixed(1)}k` : String(Math.round(v)));

function Breakdown({ rows, future, colorOf }: { rows: { p: PortfolioDto; hs: HoldingDto[]; principal: number; returns: number; yld: number }[]; future: Payout[]; colorOf: (id: string) => string }) {
  const { go } = useApp();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="bs-card flush rp-break" aria-labelledby="hb-h">
      <h2 id="hb-h" className="bs-h2">
        Holding breakdown
      </h2>
      <div className="rp-thead" aria-hidden="true">
        <span>Holding</span>
        <span>Active principal</span>
        <span>Expected returns</span>
        <span>Yield</span>
        <span />
      </div>
      {rows.map((r) => {
        const isOpen = open === r.p.id;
        return (
          <div key={r.p.id} className="rp-hrow">
            <button className="rp-tr" onClick={() => setOpen(isOpen ? null : r.p.id)} aria-expanded={isOpen}>
              <span className="who">
                <i className="av" style={{ borderColor: colorOf(r.p.id) }}>
                  {initial(r.p.ownerLabel ?? r.p.name)}
                </i>
                <span>
                  <b>{r.p.name}</b>
                  <span className="sub">
                    {r.p.ownerType === 'family' ? <span className="fam">Family{r.p.ownerLabel ? ` · ${r.p.ownerLabel}` : ''}</span> : <span className="fam self">You</span>}
                    {r.p.statementDate ? ` • Statement ${formatDate(r.p.statementDate)}` : ''}
                  </span>
                </span>
              </span>
              <span className="c" data-l="Active principal">
                {r.principal ? inr(r.principal) : '–'}
              </span>
              <span className="c" data-l="Expected returns">
                {r.returns ? inr(r.returns) : '–'}
              </span>
              <span className="c" data-l="Yield">
                {r.principal ? <span className="ychip">{pct(r.yld)}</span> : '–'}
              </span>
              <Icon name={isOpen ? 'arrow-up-s-line' : 'arrow-down-s-line'} size={20} className="chev" />
            </button>
            {isOpen && (
              <div className="rp-bonds">
                {r.hs.map((h) => {
                  const nx = future.find((e) => e.holdingId === h.id);
                  return (
                    <div key={h.id} className="b tap" role="button" tabIndex={0} onClick={() => go({ name: 'bond', id: h.id })}>
                      <span>
                        <b>{h.name}</b>
                        <span className="sub">
                          {h.isin} · {h.units} units · {h.couponRate.toFixed(2)}% {FREQUENCY_LABEL[h.frequency].toLowerCase()} · matures {formatDate(h.maturityDate)}
                        </span>
                      </span>
                      <span className="r">
                        <b>{inr(h.principal)}</b>
                        <span className="sub">{nx ? `Next ${inr(Math.round(nx.amount))} on ${formatDate(nx.date)}` : 'No upcoming payout'}</span>
                      </span>
                    </div>
                  );
                })}
                {!r.hs.length && <span className="sub">No active bonds.</span>}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

function share(d: Overview, today: string) {
  const s = d.summary;
  const body = [
    `My external bond holdings as on ${formatDateNumeric(today)}`,
    `Active principal: ${inr(s.principal)}`,
    `Expected returns: ${inr(Math.round(s.expectedInterest))}`,
    `Expected yield: ${pct(s.avgCoupon)}`,
    s.nextPayout ? `Next payout: ${inr(Math.round(s.nextPayout.amount))} on ${formatDate(s.nextPayout.date)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  location.href = `mailto:?subject=${encodeURIComponent('My bond portfolio report')}&body=${encodeURIComponent(body)}`;
}

function downloadCsv(d: Overview, payouts: Payout[], today: string) {
  const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const fut = payouts.filter((e) => e.date >= today);
  const L: unknown[][] = [['BondScanner External Holdings report', `As on ${formatDateNumeric(today)}`], [], ['Holding', 'Bond', 'ISIN', 'Units', 'Coupon %', 'Payout', 'Maturity', 'Active principal', 'Expected interest', 'Next payout', 'Next amount']];
  for (const h of d.holdings) {
    const ev = fut.filter((e) => e.holdingId === h.id);
    L.push([d.portfolios.find((p) => p.id === h.portfolioId)?.name, h.name, h.isin, h.units, h.couponRate, FREQUENCY_LABEL[h.frequency], formatDateNumeric(h.maturityDate), h.principal, ev.reduce((a, e) => a + e.interest, 0).toFixed(2), ev[0] ? formatDateNumeric(ev[0].date) : '', ev[0]?.amount ?? '']);
  }
  const months = new Map<string, { interest: number; principal: number }>();
  for (const e of fut) {
    const o = months.get(e.date.slice(0, 7)) ?? { interest: 0, principal: 0 };
    o.interest += e.interest;
    o.principal += e.principal;
    months.set(e.date.slice(0, 7), o);
  }
  L.push([], ['Month', 'Interest', 'Principal back', 'Total']);
  for (const [k, v] of months) L.push([k, v.interest.toFixed(2), v.principal.toFixed(2), (v.interest + v.principal).toFixed(2)]);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + L.map((r) => r.map(q).join(',')).join('\r\n')], { type: 'text/csv' }));
  a.download = `external-holdings-${today}.csv`;
  a.click();
}
