import { useState } from 'react';
import { formatDate, formatDateNumeric, FREQUENCY_LABEL, inr, pct } from '@eh/core';
import { SubHead, useApp, useLoad } from '../app';
import type { Payout } from '../api/types';
import { initialsOf, Skeleton, StatusBadge } from '../ui';
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

  const rows: [string, string][] = [
    ['ISIN', h.isin],
    ['Holding', portfolio?.name ?? '–'],
    ['Total units', String(h.units)],
    ['Total invested', h.investedAmount ? inr(h.investedAmount) : '–'],
    ['Active principal', inr(h.principal)],
    ['Coupon rate', `${h.couponRate.toFixed(2)}% p.a.`],
    ['Interest payment', FREQUENCY_LABEL[h.frequency]],
    ['Credit rating', h.rating],
    ['Maturity date', formatDateNumeric(h.maturityDate)],
    ['Interest receivable till maturity', inr(totalInterest)],
    ['Data source', h.verified ? 'Exchange data' : 'Details you entered (to be verified)'],
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
          <h3 className="bs-h2">{upcoming.length === 1 ? 'Upcoming payout' : 'Upcoming payouts'}</h3>
          {upcoming.length ? (
            <div className="up-list">
              {upcoming.slice(0, showPast ? undefined : 6).map((e) => (
                <PayRow key={e.key} e={e} onOpen={setOpen} />
              ))}
              {upcoming.length > 6 && !showPast && (
                <button className="link" style={{ alignSelf: 'flex-start' }} onClick={() => setShowPast(true)}>
                  Show all {upcoming.length} payouts till maturity
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
