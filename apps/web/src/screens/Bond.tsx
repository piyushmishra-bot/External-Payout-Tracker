import { useState } from 'react';
import { formatDate, formatDateNumeric, FREQUENCY_LABEL, inr, pct } from '@eh/core';
import { SubHead, useApp, useLoad } from '../app';
import type { Payout } from '../api/types';
import { Icon, initialsOf, Skeleton, StatusBadge } from '../ui';
import { PayoutSheet } from './Payouts';

/**
 * One external bond: investment details and its payouts.
 * Modelled on BondScanner's own holding page (Holdings → a bond): Investment details,
 * the investment entry, and Upcoming payout(s) on the right on desktop.
 */
export function BondScreen({ id }: { id: string }) {
  const { api, go } = useApp();
  const ov = useLoad(() => api.overview('all'), []);
  const pays = useLoad(() => api.payouts({}), []);
  const [open, setOpen] = useState<string | null>(null);
  const [showPast, setShowPast] = useState(false);
  const h = ov.data?.holdings.find((x) => x.id === id);
  const back = () => go({ name: 'external' });

  if (!ov.data || !pays.data)
    return (
      <>
        <SubHead title="Bond details" onBack={back} />
        <div className="bs-page">
          <Skeleton h={220} />
        </div>
      </>
    );
  if (!h)
    return (
      <>
        <SubHead title="Bond details" onBack={back} />
        <div className="bs-page">
          <div className="bs-card empty">This bond is no longer in your external holdings.</div>
        </div>
      </>
    );

  const today = ov.data.today;
  const portfolio = ov.data.portfolios.find((p) => p.id === h.portfolioId);
  const events = pays.data.payouts.filter((e) => e.holdingId === h.id);
  const upcoming = events.filter((e) => e.date >= today);
  const past = events.filter((e) => e.date < today);
  const totalInterest = upcoming.reduce((a, e) => a + e.interest, 0);

  // Only the details BondScanner's Holdings shows for a bond.
  const rows: [string, string][] = [
    ['ISIN', h.isin],
    ['Total units', String(h.units)],
    ['Total invested', h.investedAmount ? inr(h.investedAmount) : '–'],
    ['Maturity date', formatDateNumeric(h.maturityDate)],
  ];

  return (
    <>
      <SubHead title="Bond details" onBack={back} titleMobileOnly />
      <div className="bs-page bond-page">
        <div className="bond-main">
          <div className="bond-title">
            <span className="bs-logo" aria-hidden="true">
              {initialsOf(h.issuer)}
            </span>
            <span>
              <h2>{h.name}</h2>
              <span className="isin">
                {h.isin}
                {h.matured && ' · Matured'}
              </span>
            </span>
          </div>

          <h3 className="bs-h2">Investment details</h3>
          <div className="dtable">
            {rows.map(([k, v]) => (
              <div key={k}>
                <span>{k}</span>
                <b>{v}</b>
              </div>
            ))}
          </div>

          {(h.investedOn || h.purchaseYield != null || h.investedAmount) && (
            <>
              <h3 className="bs-h2">Transactions</h3>
              <div className="wrap txn-tabs" role="group" aria-label="Transactions">
                <button className="chip" aria-pressed="true">
                  Buy transactions
                </button>
              </div>
              <div className="txn">
                <span className="l">
                  <b>{h.investedOn ? `Invested on ${formatDateNumeric(h.investedOn)}` : 'Investment'}</b>
                  <span>Inv amt. {h.investedAmount ? inr(h.investedAmount) : '–'}</span>
                </span>
                <span className="r">
                  {h.purchaseYield != null && <b className="green">@{pct(h.purchaseYield)}</b>}
                  <span>Units {h.units}</span>
                </span>
              </div>
            </>
          )}
        </div>

        <aside className="bond-side">
          <h3 className="bs-h2">Upcoming external payouts</h3>
          {upcoming.length ? (
            <div className="up-list">
              {/* The next payout; the rest open and close with View all / Hide. */}
              {upcoming.slice(0, showPast ? undefined : 1).map((e) => (
                <PayRow key={e.key} e={e} onOpen={setOpen} />
              ))}
              {upcoming.length > 1 && (
                <button className="up-toggle" onClick={() => setShowPast(!showPast)} aria-expanded={showPast} data-track="bond_payouts_toggle">
                  <u>{showPast ? 'Hide payouts' : `View all ${upcoming.length} payouts till maturity`}</u>
                  <Icon name={showPast ? 'arrow-up-s-line' : 'arrow-down-s-line'} size={18} />
                </button>
              )}
            </div>
          ) : (
            <div className="bs-card empty">No upcoming payouts. {h.matured ? 'This bond has matured.' : ''}</div>
          )}
          {past.length > 0 && (
            <>
              <h3 className="bs-h2">Past payouts</h3>
              <div className="up-list">
                {past
                  .slice()
                  .reverse()
                  .map((e) => (
                    <PayRow key={e.key} e={e} onOpen={setOpen} />
                  ))}
              </div>
            </>
          )}
          <p className="bs-note">Amounts are before TDS. Interest is paid to the holder on the record date.</p>
        </aside>
      </div>
      {open && <PayoutSheet date={open} events={events.filter((e) => e.date === open)} onClose={() => setOpen(null)} onChanged={pays.reload} />}
    </>
  );
}

function PayRow({ e, onOpen }: { e: Payout; onOpen: (d: string) => void }) {
  return (
    <button className="up-row" onClick={() => onOpen(e.date)}>
      <span className="d">{formatDate(e.date)}</span>
      <span className="k">{e.principal > 0 ? (e.interest > 0 ? 'Interest + Principal' : 'Principal') : 'Interest'}</span>
      {e.status !== 'upcoming' && <StatusBadge status={e.status} />}
      <span className="a">{inr(e.amount)}</span>
    </button>
  );
}
