import { useEffect, useState } from 'react';
import { formatDate, formatDateNumeric, FREQUENCY_LABEL, inr, pct } from '@eh/core';
import { SearchPill, useApp, useLoad } from '../app';
import { InvRow, KV, RowMenuBtn } from './Holdings';
import { InvestmentSheet } from './AddFlow';
import type { Overview, PortfolioDto } from '../api/types';
import { Confirm, Icon, initialsOf, PhIcon, Sheet } from '../ui';

/** A bond as the row menu needs it: who it is and its current investment details. */
type BondRef = { id: string; isin: string; name: string; units: number; acquiredOn?: string; investedAmount?: number; purchaseYield?: number; issuerName?: string; awaiting?: boolean };

/** Bond portfolio tracker: payouts, coupon, maturity and expected returns from the bond directory. */
const SHOW_PAYOUTS = true;
const NOTE = 'Payouts are calculated from each bond’s terms and are shown before TDS. Actual credits may differ slightly with holidays and record dates.';

/** Overview like BondScanner's Holdings: interest this month (eye hides the figures), then principal, returns and yield. */
function TrackerBox({ d, hide, setHide }: { d: Overview; hide: boolean; setHide: (b: boolean) => void }) {
  const s = d.summary;
  const month = new Date(`${d.today}T00:00:00`).toLocaleDateString('en-IN', { month: 'short' }) + `’${d.today.slice(2, 4)}`;
  const H = (v: string) => (hide ? '********' : v);
  const yld = s.xirr ?? s.avgCoupon;
  return (
    <section className="bs-card" aria-label="Overview">
      <div className="bs-row" style={{ alignItems: 'flex-start' }}>
        <div>
          <div className="bs-label">
            Interest <span className="dot-sep">•</span> {month}
          </div>
          <div className="bs-big">{H(inr(s.interestThisMonth))}</div>
        </div>
        <button className="eye-btn" onClick={() => setHide(!hide)} aria-label={hide ? 'Show amounts' : 'Hide amounts'} data-track="overview_eye">
          <PhIcon name={hide ? 'eye-closed' : 'eye'} size={18} />
        </button>
      </div>
      <div className="bs-kvs">
        <KV k="Active principal" v={H(inr(s.principal))} />
        <KV k="Expected returns" v={H(inr(s.expectedInterest))} />
        <KV k="Expected yield" v={H(pct(Math.round(yld * 100) / 100))} green={!hide} />
      </div>
    </section>
  );
}

/** Overview of the consolidated portfolio: total invested, number of bonds, average yield (weighted by amount). */
export function ConsolidatedBox({ d, hide }: { d: Overview; hide: boolean; setHide?: (b: boolean) => void }) {
  const all = [...d.holdings.map((h) => ({ isin: h.isin, inv: h.investedAmount ?? 0, y: h.purchaseYield ?? null })), ...d.awaiting.map((a) => ({ isin: a.isin, inv: a.investedAmount ?? 0, y: a.purchaseYield ?? null }))];
  // No. of bonds: every bond added (the same ISIN bought on two dates counts twice).
  const bonds = all.length;
  const total = all.reduce((s, x) => s + x.inv, 0);
  const withYield = all.filter((x) => x.y != null && x.inv > 0);
  const w = withYield.reduce((s, x) => s + x.inv, 0);
  const avgYield = w ? withYield.reduce((s, x) => s + x.inv * x.y!, 0) / w : null;
  return (
    <section className="bs-card" aria-label="Overview">
      <div className="bs-row" style={{ alignItems: 'flex-start' }}>
        <div>
          <div className="bs-label">Total investment</div>
          <div className="bs-big">{hide ? '₹••••' : inr(total)}</div>
        </div>

      </div>
      <div className="bs-kvs">
        <KV k="Total no. of bonds" v={hide ? "••••" : String(bonds)} />
        <KV k="Average yield" v={avgYield == null ? '–' : hide ? '••••' : pct(Math.round(avgYield * 100) / 100)} green={!hide} />
      </div>
    </section>
  );
}

export const MIX_COLOR: Record<string, string> = { AAA: '#1C398E', AA: '#3B82F6', A: '#93C5FD', BBB: '#F59E0B', 'Below BBB': '#E7000B', Unrated: '#94A3B8' };

export function ExternalScreen({ detailsId }: { detailsId?: string }) {
  const { api, go } = useApp();
  const [scope, setScope] = useState('all');
  const [hide, setHide] = useState(false);
  const [q, setQ] = useState('');
  const ov = useLoad(() => api.overview(scope), [scope], `overview:${scope}`);
  const all = useLoad(() => (scope === 'all' ? Promise.resolve(null) : api.overview('all')), [scope], scope === 'all' ? undefined : 'overview:all');
  const d = ov.data;
  const allData: Overview | null = scope === 'all' ? d : all.data;
  const has = (allData?.portfolios.length ?? 0) > 0;

  return (
    <>
      <div className={`bs-page ${allData && !has ? 'bs-narrow' : ''}`}>
        <header className="ep-hero">
          <h1>External bonds portfolio</h1>
          <p>Track the bonds you hold outside BondScanner, your portfolio, upcoming payouts and maturity dates in one place.</p>
        </header>
        <AssistedStatus />

        {!allData ? (
          // First visit only (later visits show the last data at once): plain white space, no grey placeholder.
          <div className="ep-wait" aria-busy="true" />
        ) : !has ? (
          <>
            <EmptyState />
            <Faq />
          </>
        ) : (
          <div className="cols2">
          <div className="c-main">
            {/* Phones and tablets: "Add holdings ›" beside the heading, like "Payout details ›" on bondscanner.com.
                Desktop has the Update holdings card on the right instead. */}
            <div className="ov-head">
              <h2 className="bs-h2" style={{ margin: 0 }}>
                Overview
              </h2>
              <button className="ov-add ov-link m-only" onClick={() => go({ name: 'payouts' })} data-track="payout_details_link">
                <u>External payout details</u>
                <Icon name="arrow-right-s-line" size={20} />
              </button>
            </div>
            {d ? <TrackerBox d={d} hide={hide} setHide={setHide} /> : <div className="ep-wait" aria-busy="true" />}

            {d && <Investments d={d} hide={hide} q={q} detailsId={detailsId} />}
            {/* Portfolio report below the investments (BondScanner shows its report entry the same way). */}
            <section className="stack-sm" aria-labelledby="rep-h">
              <h2 id="rep-h" className="bs-h2" style={{ margin: 0 }}>
                External portfolio tracker
              </h2>
              <div className="bs-card report-row">
                <span className="report-ic" aria-hidden="true">
                  <Icon name="pie-chart-2-line" size={22} />
                </span>
                <span className="report-t">
                  <b>See your full report</b>
                  <span>Returns, payouts by month and how your money is spread across issuers and ratings.</span>
                </span>
                <button className="btn btn-outline report-btn" onClick={() => go({ name: 'report' })} data-track="report_card">
                  View report
                </button>
              </div>
            </section>
            <Faq />
            <p className="bs-note d-only">
              <b>Note:</b> {NOTE}
            </p>
          </div>
          <aside className="c-side">
            <div className="stack-sm d-only">
              <h2 className="bs-h2" style={{ margin: 0 }}>
                External payout details
              </h2>
              {/* Same card as "Payout details" on BondScanner Holdings */}
              <div className="pd-card">
                <div className="pd-text">
                  <b>See month by month breakdown</b>
                  <span>View all your external holdings payouts</span>
                  <button className="btn btn-primary pd-btn" onClick={() => go({ name: 'payouts' })} data-track="open_tracker">
                    Open tracker
                  </button>
                </div>
                <svg className="pd-art" viewBox="0 0 220 130" aria-hidden="true">
                  <rect x="40" y="88" width="34" height="42" rx="3" fill="#dbe4fb" />
                  <rect x="92" y="70" width="34" height="60" rx="3" fill="#dbe4fb" />
                  <rect x="144" y="44" width="34" height="86" rx="3" fill="#dbe4fb" />
                  <rect x="196" y="30" width="34" height="100" rx="3" fill="#dbe4fb" />
                  <path d="M20 98 L66 96 L92 70 L150 66 L170 44" fill="none" stroke="#6b8ff5" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M176 38 L214 18" fill="none" stroke="#22c55e" strokeWidth="3" strokeDasharray="6 6" strokeLinecap="round" />
                  <g>
                    <rect x="4" y="86" width="84" height="24" rx="12" fill="#fff" stroke="#e5e7eb" />
                    <text x="46" y="102" textAnchor="middle" fontSize="9" fill="#101828">Interest payout</text>
                  </g>
                  <g>
                    <rect x="104" y="36" width="92" height="24" rx="12" fill="#fff" stroke="#e5e7eb" />
                    <text x="150" y="52" textAnchor="middle" fontSize="9" fill="#101828">Principal payout</text>
                  </g>
                </svg>
              </div>
            </div>
            <p className="bs-note m-only">
              <b>Note:</b> {NOTE}
            </p>
          </aside>
          </div>
        )}
      </div>
      {has && <div className="m-only"><SearchPill value={q} onChange={setQ} /></div>}
    </>
  );
}

/** The five questions people ask most, as on bondscanner.com's FAQ: one open at a time. */
const FAQS: { q: string; a: string }[] = [
  {
    q: 'What is the external bonds portfolio?',
    a: 'It is a single view of the bonds you have bought outside BondScanner, on other platforms or through a broker. Add them once to track your investment, upcoming payouts, maturity dates and returns in one place.',
  },
  {
    q: 'How do I add my bonds?',
    a: 'Click Add external holdings and choose one of the following, Enter details, to type the ISIN, issuer name, date of investment, yield, units and investment amount for each bond; or Upload a file, to upload our Excel or CSV template with one bond per row. If you have a broker statement or screenshot instead, share it with us and we will add your holdings within 24 hours.',
  },
  {
    q: 'Where do the payout dates and amounts come from?',
    a: 'We calculate them from each bond’s terms (coupon rate, payout frequency, face value and maturity) in BondScanner’s bond directory. Amounts are before TDS. If a bond is not in our directory yet, it shows as Details awaited and its payouts appear once the details are available.',
  },
  {
    q: 'I bought the same bond more than once. How do I add it?',
    a: 'Add one row for each date of investment. Rows with the same ISIN and the same date of investment are combined into one. If you have already added a bond with the same date, we will ask whether to replace it or keep both.',
  },
  {
    q: 'How do I update or remove my bonds?',
    a: 'Click Edit above the table. Use the pencil icon to update a bond or the cross icon to remove it. To add more bonds, click Add external holdings.',
  },
  {
    q: 'Is my data safe? Do you access my demat account?',
    a: 'Your data is safe with us. We only store the details you enter or share with us. We do not connect to your demat account, broker or bank, and your investments elsewhere are not affected. You can remove any bond at any time.',
  },
];

function Faq() {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <section className="faq" aria-labelledby="faq-h">
      <h2 id="faq-h" className="bs-h2">
        Frequently asked questions
      </h2>
      <div className="faq-list">
        {FAQS.map((f, i) => (
          <div key={f.q} className={`faq-item ${open === i ? 'open' : ''}`}>
            <button className="faq-q" data-track={`faq_${i + 1}`} aria-expanded={open === i} aria-controls={`faq-a-${i}`} onClick={() => setOpen(open === i ? null : i)}>
              <span>{f.q}</span>
              <Icon name={open === i ? 'arrow-up-s-line' : 'arrow-down-s-line'} size={20} />
            </button>
            {open === i && (
              <p id={`faq-a-${i}`} className="faq-a">
                {f.a}
              </p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function EmptyState() {
  const { go } = useApp();
  return (
    // Same visual language as bondscanner.com/payout-detector: a Grey 50 panel with a title row and white cards, left-aligned.
    <section className="ep-panel" aria-labelledby="empty-h">
      <div className="ep-panel-head">
        <Icon name="stack-line" size={24} />
        <h2 id="empty-h">Get started</h2>
        <span>(Takes about 2 minutes)</span>
      </div>
      <div className="ep-steps">
        {[
          { ic: 'download-2-line', t: 'Download template', d: 'Download the Excel or CSV template.' },
          { ic: 'table', t: 'Fill in your bonds', d: 'Enter your investment details in the template.' },
          { ic: 'stack-line', t: 'Upload external holdings', d: 'View your investments in one place.' },
        ].map((st, n) => (
          <div className="ep-step" key={st.t}>
            <span className="ic" aria-hidden="true">
              {st.ic === 'table' ? <PhIcon name="table" size={24} /> : <Icon name={st.ic as 'stack-line'} size={24} />}
            </span>
            <span className="step-tag">Step {n + 1}</span>
            <b>{st.t}</b>
            <span className="ep-desc">{st.d}</span>
          </div>
        ))}
      </div>
      <div className="ep-panel-foot">
        <button className="btn btn-primary ep-cta" onClick={() => go({ name: 'add' })} data-track="get_started_add">
          <Icon name="add-line" size={20} /> Add external holdings
        </button>
      </div>
    </section>
  );
}

function Investments({ d, hide, q, detailsId }: { d: Overview; hide: boolean; q: string; detailsId?: string }) {
  const { api, toast, refresh, go, addHoldings } = useApp();
  const [fill, setFill] = useState<Overview['awaiting'][number] | null>(null);
  // Opened from the "add details" reminder: open the form for that bond.
  useEffect(() => {
    const a = detailsId && d.awaiting.find((x) => x.id === detailsId);
    if (a) setFill(a);
  }, [detailsId, d.awaiting]);
  const [sheet, setSheet] = useState<{ kind: 'menu' | 'rename' | 'delete'; p: PortfolioDto } | null>(null);
  // One bond: its menu, the edit form, or the remove confirmation.
  const [bond, setBond] = useState<{ kind: 'menu' | 'edit' | 'remove'; b: BondRef } | null>(null);
  // Active or matured bonds, like the Active ▾ filter on BondScanner Holdings.
  const [view, setView] = useState<'active' | 'matured'>('active');
  // Holding in edit mode (name, delete, per-row edit and remove), like the BondScanner watchlist.
  const [editing, setEditing] = useState<string | null>(null);
  const ql = q.trim().toLowerCase();
  const hit = (text: string) => !ql || text.toLowerCase().includes(ql);
  // One view for all holdings: every bond in a single table.
  const groups = d.portfolios.length ? [d.portfolios[0]] : [];
  const any = d.holdings.some((h) => hit(`${h.name} ${h.issuer} ${h.isin}`)) || d.awaiting.some((a) => hit(a.isin));
  const matured = d.holdings.filter((h) => h.matured).length;
  const gid = groups[0]?.id ?? null;
  const isEditingAny = !!gid && editing === gid;
  return (
    <>
      <div className="inv-head">
        <h2 className="bs-h2">Investments</h2>
        <label className="year-pill view-pill">
          <span className="sr-only">Show</span>
          <select value={view} onChange={(e) => setView(e.target.value as 'active' | 'matured')} data-track="inv_view">
            <option value="active">Active</option>
            <option value="matured">Matured</option>
          </select>
          <Icon name="arrow-down-s-line" size={18} />
        </label>
        {/* Phones: add and edit as icons, like the BondScanner watchlist */}
        <span className="inv-icons">
          {isEditingAny ? (
            <button className="inv-done" onClick={() => setEditing(null)} data-track="m_edit_done">
              Done
            </button>
          ) : (
            <>
              <button className="inv-ic" aria-label="Add holdings" onClick={addHoldings} data-track="m_add_holdings">
                <PhIcon name="plus-circle" size={20} />
              </button>
              <button className="inv-ic" aria-label="Edit holdings" onClick={() => setEditing(gid)} data-track="m_edit">
                <PhIcon name="pencil-simple" size={20} />
              </button>
            </>
          )}
        </span>
      </div>
      <div className="bs-table hold-card">
        {groups.map((p) => {
          const rows = d.holdings.filter((h) => hit(`${h.name} ${h.issuer} ${h.isin}`) && (view === 'matured' ? h.matured : !h.matured));
          const aw = view === 'matured' ? [] : d.awaiting.filter((a) => hit(`${a.isin} ${a.name}`));
          const isEditing = editing === p.id;
          const H = (v: string) => (hide ? '********' : v);
          const acts = (ref: BondRef) => (
            <span className="row-acts" onClick={(e) => e.stopPropagation()}>
              <button className="icon-btn" aria-label={`Edit ${ref.isin}`} title="Edit" onClick={() => setBond({ kind: 'edit', b: ref })} data-track="row_edit">
                <Icon name="pencil-line" size={16} />
              </button>
              <button className="icon-btn" aria-label={`Remove ${ref.isin}`} title="Remove" onClick={() => setBond({ kind: 'remove', b: ref })} data-track="row_remove">
                <Icon name="close-line" size={18} />
              </button>
            </span>
          );
          return (
            <div key={p.id}>
              <HoldingBar editing={isEditing} onEdit={() => setEditing(p.id)} onDone={() => setEditing(null)} />
              <div className="bs-thead inv-thead">
                <span>Issuer</span>
                <span>{view === 'matured' ? 'Investment amount' : 'Active principal'}</span>
              </div>
              {rows.map((h) => {
                const ref: BondRef = { id: h.id, isin: h.isin, name: h.name, units: h.units, acquiredOn: h.investedOn ?? undefined, investedAmount: h.investedAmount ?? undefined, purchaseYield: h.purchaseYield ?? undefined };
                const open = () => go({ name: 'bond', id: h.id });
                return (
                  <div
                    key={h.id}
                    className={`inv-row ${isEditing ? '' : 'tap'}`}
                    onClick={isEditing ? undefined : open}
                    onKeyDown={(e) => !isEditing && (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), open())}
                    role={isEditing ? undefined : 'link'}
                    tabIndex={isEditing ? undefined : 0}
                    data-track={isEditing ? undefined : 'row_open_bond'}
                  >
                    <span className="bs-logo" aria-hidden="true">
                      {initialsOf(h.name)}
                    </span>
                    <span className="inv-mid">
                      <span className="inv-nm" title={h.name}>
                        {h.name}
                      </span>
                      <span className="inv-isin">{h.isin}</span>
                    </span>
                    <span className="inv-end">
                      <span className="inv-amt">{H(inr(view === 'matured' ? h.investedAmount ?? h.units * h.faceValue : h.principal))}</span>
                      <span className="inv-units">({H(String(h.units))} units)</span>
                    </span>
                    {isEditing ? acts(ref) : <Icon name="arrow-right-s-line" size={20} className="inv-chev" />}
                  </div>
                );
              })}
              {aw.map((a) => {
                const nm = a.name && a.name !== 'Details awaited' ? a.name : a.isin;
                const ref: BondRef = { id: a.id, isin: a.isin, name: nm, units: a.units, acquiredOn: a.investedOn, investedAmount: a.investedAmount, purchaseYield: a.purchaseYield, issuerName: nm !== a.isin ? nm : undefined, awaiting: true };
                return (
                  <div key={a.id} className="inv-row">
                    <span className="bs-logo" aria-hidden="true">
                      {initialsOf(nm)}
                    </span>
                    <span className="inv-mid">
                      <span className="inv-nm" title={nm}>
                        {nm}
                      </span>
                      <span className="inv-isin">
                        {a.isin} <span className="muted-tag">Details awaited</span>
                      </span>
                    </span>
                    <span className="inv-end">
                      <span className="inv-amt">{a.investedAmount ? H(inr(a.investedAmount)) : '–'}</span>
                      <span className="inv-units">({H(String(a.units))} units)</span>
                    </span>
                    {isEditing ? acts(ref) : <span className="inv-chev-gap" />}
                  </div>
                );
              })}
              {!rows.length && !aw.length && <div className="inv-empty">{view === 'matured' ? 'No matured bonds yet.' : 'No active bonds.'}</div>}
            </div>
          );
        })}
      </div>
      {!any && <div className="bs-card empty">No bonds match your search.</div>}

      {fill && (
        <InvestmentSheet
          isin={fill.isin}
          initial={{ units: fill.units, acquiredOn: fill.investedOn, investedAmount: fill.investedAmount, purchaseYield: fill.purchaseYield }}
          today={d.today}
          intro="This bond is not yet in our records. Bond terms will be fetched from the ISIN once available. Add your investment details."
          onClose={() => (setFill(null), detailsId && go({ name: 'external' }))}
          onSave={async (v) => {
            await api.setInvestment(fill.id, v);
            setFill(null);
            toast('Details updated');
            refresh();
            if (detailsId) go({ name: 'external' });
          }}
        />
      )}
      {bond?.kind === 'menu' && (
        <Sheet onClose={() => setBond(null)} label={bond.b.name}>
          <h3 className="h-card">{bond.b.name}</h3>
          {bond.b.name !== bond.b.isin && <p className="p small muted">{bond.b.isin}</p>}
          <button className="btn btn-outline btn-block" onClick={() => setBond({ kind: 'edit', b: bond.b })}>
            <Icon name="pencil-line" size={18} /> Edit details
          </button>
          <button className="btn btn-outline btn-block btn-danger-text" onClick={() => setBond({ kind: 'remove', b: bond.b })}>
            <Icon name="delete-bin-line" size={18} /> Remove bond
          </button>
        </Sheet>
      )}
      {bond?.kind === 'edit' && (
        <InvestmentSheet
          isin={bond.b.isin}
          title="Edit details"
          initial={{ units: bond.b.units, acquiredOn: bond.b.acquiredOn, investedAmount: bond.b.investedAmount, purchaseYield: bond.b.purchaseYield, issuerName: bond.b.issuerName ?? (bond.b.name !== bond.b.isin ? bond.b.name : undefined) }}
          today={d.today}
          intro={bond.b.awaiting ? 'We do not have the details of this bond yet. They will be updated automatically once available.' : undefined}
          onClose={() => setBond(null)}
          onSave={async (v) => {
            await api.setInvestment(bond.b.id, v);
            setBond(null);
            toast('Details updated');
            refresh();
          }}
        />
      )}
      {bond?.kind === 'remove' && (
        <Confirm
          title="Remove bond?"
          body="This bond will be removed from your holdings."
          confirm="Yes, remove"
          track="remove_bond"
          onClose={() => setBond(null)}
          onConfirm={async () => {
            await api.removeHolding(bond.b.id);
            setBond(null);
            toast('Bond removed');
            refresh();
          }}
        />
      )}
      {sheet?.kind === 'menu' && (
        <Sheet onClose={() => setSheet(null)} label={sheet.p.name}>
          <h3 className="h-card">{sheet.p.name}</h3>
          <button className="btn btn-outline btn-block" onClick={() => setSheet({ kind: 'rename', p: sheet.p })}>
            <Icon name="pencil-line" size={18} /> Rename
          </button>
          <button className="btn btn-outline btn-block btn-danger-text" onClick={() => setSheet({ kind: 'delete', p: sheet.p })}>
            <Icon name="delete-bin-line" size={18} /> Delete
          </button>
        </Sheet>
      )}
      {sheet?.kind === 'rename' && (
        <RenameSheet
          current={sheet.p.name}
          onClose={() => setSheet(null)}
          onSave={async (n) => {
            const r = await api.rename(sheet.p.id, n);
            toast(`Renamed to ${r.name}`);
            setSheet(null);
            refresh();
          }}
        />
      )}
      {sheet?.kind === 'delete' && (
        <Confirm
          title="Delete holding?"
          body={
            <>
              This will permanently delete <b>‘{sheet.p.name}’</b> and remove all its bonds.
            </>
          }
          confirm="Yes, delete"
          onClose={() => setSheet(null)}
          onConfirm={async () => {
            await api.deletePortfolio(sheet.p.id);
            setSheet(null);
            toast('Deleted');
            refresh();
          }}
        />
      )}
    </>
  );
}

/** Bar above the table: + Add holdings on the left; Edit on the right (while editing: Done, and edit/remove on each row). */
function HoldingBar({ editing, onEdit, onDone }: { editing: boolean; onEdit: () => void; onDone: () => void }) {
  const { addHoldings } = useApp();
  return (
    <div className="hold-bar">
      <button className="btn btn-outline btn-sm" onClick={addHoldings} data-track="add_holdings_table">
        <PhIcon name="plus" size={16} /> Add external holdings
      </button>
      {editing ? (
        <button className="btn btn-primary btn-sm" onClick={onDone} data-track="edit_done">
          Done
        </button>
      ) : (
        <button className="btn btn-outline btn-sm" onClick={onEdit} data-track="edit_holdings">
          <PhIcon name="pencil-simple" size={16} /> Edit
        </button>
      )}
    </div>
  );
}

/** Files sent in any format: "being added" until our team marks them done, then "added" for a week. */
const DISMISS_KEY = 'eh-assist-dismissed';
function AssistedStatus() {
  const { api } = useApp();
  const r = useLoad(() => api.myAssisted(), []);
  // Closed for this visit only (sessionStorage): it shows again the next time they open the page.
  const [closed, setClosed] = useState<string[]>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(DISMISS_KEY) ?? '[]');
    } catch {
      return [];
    }
  });
  const close = (key: string) => {
    const next = [...closed, key];
    setClosed(next);
    try {
      sessionStorage.setItem(DISMISS_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };
  const list = r.data ?? [];
  const pending = list.filter((x) => x.status === 'received');
  const done = list.filter((x) => x.status === 'done');
  const pKey = `p:${pending.map((x) => x.id).join(',')}`;
  const dKey = `d:${done.map((x) => x.id).join(',')}`;
  const showP = pending.length > 0 && !closed.includes(pKey);
  const showD = done.length > 0 && !closed.includes(dKey);
  if (!showP && !showD) return null;
  return (
    <div className="assist-status" role="status">
      {showP && (
        <div className="assist-line">
          <span className="assist-ic">
            <Icon name="time-line" size={18} />
          </span>
          <span className="assist-msg">
            <b>We are adding your holdings</b> from the file you shared. This may take up to 24 hours. They will appear here once added.
          </span>
          <button className="assist-x" aria-label="Close" onClick={() => close(pKey)} data-track="banner_close">
            <Icon name="close-line" size={18} />
          </button>
        </div>
      )}
      {showD && (
        <div className="assist-line done">
          <span className="assist-ic">
            <Icon name="check-line" size={18} />
          </span>
          <span className="assist-msg">
            <b>Your holdings have been updated</b> from the file you shared.
          </span>
          <button className="assist-x" aria-label="Close" onClick={() => close(dKey)} data-track="banner_close">
            <Icon name="close-line" size={18} />
          </button>
        </div>
      )}
    </div>
  );
}

/** Upcoming payouts as a schedule table (date, bond, interest, principal, total), like payout-detector's list. */
function UpcomingPayouts({ scope, hide }: { scope: string; hide: boolean }) {
  const { api } = useApp();
  const p = useLoad(() => api.payouts({ scope }), [scope]);
  const { go } = useApp();
  const [all, setAll] = useState(false);
  const SHOW = 6;
  if (!p.data) return null;
  const up = p.data.payouts.filter((e) => e.date >= p.data!.today);
  const money = (v: number) => (hide ? '₹••••' : v ? inr(v) : '–');
  return (
    <section className="stack-sm" aria-labelledby="up-h">
      <div className="ov-head">
        <h2 id="up-h" className="bs-h2" style={{ margin: 0 }}>
          Upcoming payouts
        </h2>
        <button className="ov-add ov-link" onClick={() => go({ name: 'payouts' })} data-track="payout_calendar_link">
          <u>Payout calendar</u>
          <Icon name="arrow-right-s-line" size={20} />
        </button>
      </div>
      {!up.length ? (
        <div className="bs-card empty">No upcoming payouts.</div>
      ) : (
        <div className="tw bs-table">
          <table className="rt pay-rt">
            <thead>
              <tr>
                <th>Date</th>
                <th>Bond</th>
                <th className="num">Interest</th>
                <th className="num">Principal</th>
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {(all ? up : up.slice(0, SHOW)).map((e) => (
                <tr key={e.key}>
                  <td className="nowrap">{formatDate(e.date)}</td>
                  <td>
                    <span className="nm">{e.bondName}</span>
                    <span className="isin">
                      {e.isin}
                      {e.isFinal ? ' · maturity' : ''}
                      {e.estimated ? ' · estimated' : ''}
                    </span>
                  </td>
                  <td className="num">{money(e.interest)}</td>
                  <td className="num">{money(e.principal)}</td>
                  <td className="num strong">{money(e.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {up.length > SHOW && (
            <button className="bs-band" onClick={() => setAll(!all)} aria-expanded={all}>
              <u>{all ? 'Show fewer payouts' : `Show all ${up.length} payouts`}</u>
              <Icon name={all ? 'arrow-up-s-line' : 'arrow-down-s-line'} size={20} />
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function RenameSheet({ current, onClose, onSave }: { current: string; onClose: () => void; onSave: (n: string) => Promise<void> }) {
  const [v, setV] = useState(current);
  return (
    <Sheet onClose={onClose} label="Rename holding">
      <h3 className="h-card">Rename</h3>
      <div className="field">
        <label htmlFor="rn">Name</label>
        <input id="rn" className="input" value={v} maxLength={40} onChange={(e) => setV(e.target.value)} placeholder="Eg. Zerodha, Retirement portfolio" />
      </div>
      <button className="btn btn-primary btn-block" disabled={v.trim().length < 2} onClick={() => onSave(v.trim())}>
        Save
      </button>
      <button className="btn btn-ghost btn-block" onClick={onClose}>
        Cancel
      </button>
    </Sheet>
  );
}
