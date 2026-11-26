import { useMemo, useState } from 'react';
import { formatDate, inr, MONTHS_SHORT, pct } from '@eh/core';
import { SubHead, useApp, useLoad } from '../app';
import { KV } from './Holdings';
import type { Payout } from '../api/types';
import { Icon, Sheet, Skeleton, StatusBadge } from '../ui';
import { PayoutChart } from './Report';



const ord = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;
const shortDate = (iso: string) => {
  const d = new Date(iso + 'T00:00:00Z');
  return `${ord(d.getUTCDate())} ${MONTHS_SHORT[d.getUTCMonth()]} ’${String(d.getUTCFullYear()).slice(2)}`;
};

/** Payout calendar for external holdings (named differently from BondScanner's own Payout details). */
export function PayoutsScreen({ initialDate }: { initialDate?: string }) {
  const { api, go } = useApp();
  const [scope, setScope] = useState('all');
  const ov = useLoad(() => api.overview('all'), []);
  const today = ov.data?.today ?? new Date().toISOString().slice(0, 10);
  const [year, setYear] = useState<number | null>(initialDate ? Number(initialDate.slice(0, 4)) : null);
  const [openDate, setOpenDate] = useState<string | null>(initialDate ?? null);
  const all = useLoad(() => api.payouts({ scope }), [scope]);
  const scoped = useLoad(() => api.overview(scope), [scope]);
  const events = all.data?.payouts ?? [];
  // Open on this year, or on the first year that has an upcoming payout when this year has none.
  const thisYear = Number(today.slice(0, 4));
  const firstUpcoming = events.find((e) => e.date >= today);
  const Y = year ?? (events.some((e) => e.date.startsWith(String(thisYear))) || !firstUpcoming ? thisYear : Number(firstUpcoming.date.slice(0, 4)));
  const fetching = scoped.data?.awaiting.length ?? 0;
  const years = [...new Set(events.map((e) => Number(e.date.slice(0, 4))))].sort();
  if (!years.includes(Y)) years.push(Y), years.sort();
  const yearEvents = events.filter((e) => e.date.startsWith(String(Y)));
  const portfolios = ov.data?.portfolios ?? [];
  const past = events.filter((e) => e.date < today && e.status !== 'received');

  return (
    <>
      <SubHead title="Payout details" onBack={() => go({ name: 'external' })} />
      <div className="bs-page">
        {portfolios.length > 1 && (
          <div className="wrap" role="group" aria-label="Show holding">
            <button className="chip" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>
              All
            </button>
            {portfolios.map((p) => (
              <button key={p.id} className="chip" aria-pressed={scope === p.id} onClick={() => setScope(p.id)}>
                {p.name}
              </button>
            ))}
          </div>
        )}
        {/* As on BondScanner's Payout details: month-by-month chart (Interest / Principal, year), then Expected yield. */}
        <PayoutChart events={events.map((e) => ({ ...e, portfolioId: 'all' }))} today={today} series={[{ id: 'all', name: 'Payouts', color: '#1c398e' }]} title={null} year={Y} onYear={setYear} />
        <section className="bs-card slim">
          <KV k="Expected yield" v={scoped.data?.summary.holdingsCount ? pct(Math.round((scoped.data.summary.xirr ?? scoped.data.summary.avgCoupon) * 100) / 100) : '–'} />
        </section>

        {fetching > 0 && (
          <div className="infob">
            <b>We’re fetching details for {fetching === 1 ? '1 bond' : `${fetching} bonds`}.</b> {fetching === 1 ? 'Its payouts' : 'Their payouts'} will appear in this calendar as soon as we have the coupon and payout dates.
          </div>
        )}

        {past.length > 0 && <PastToConfirm past={past} onOpen={setOpenDate} />}

        <h2 className="bs-h2" style={{ margin: 0 }}>
          Payouts
        </h2>
        {!all.data ? (
          <Skeleton h={180} />
        ) : !yearEvents.length ? (
          <div className="bs-card empty">
            <b>No payouts in {Y}.</b> Matured bonds stop paying after their final payout, and bonds awaiting details are not scheduled yet.
          </div>
        ) : (
          <MonthList events={yearEvents} today={today} initialMonth={initialDate?.slice(0, 7)} onOpen={setOpenDate} />
        )}
        <p className="bs-note">
          <b>Note:</b> Amounts are before TDS. A payout on a weekend or market holiday moves to the next working day; a final redemption moves to the previous working day. BondScanner reminds you the day before and on the day.
        </p>
      </div>
      {openDate && <PayoutSheet date={openDate} events={events.filter((e) => e.date === openDate)} onClose={() => setOpenDate(null)} onChanged={all.reload} />}
    </>
  );
}

function PastToConfirm({ past, onOpen }: { past: Payout[]; onOpen: (d: string) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="pm warn">
      <button className="pm-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="pm-m">
          <Icon name="error-warning-line" size={18} />
        </span>
        <span className="pm-bar">
          <span className="lbl">Past payouts to confirm ({past.length})</span>
          <Icon name={open ? 'arrow-up-s-line' : 'arrow-down-s-line'} size={18} />
        </span>
      </button>
      {open && (
        <div className="pm-body">
          {past.map((e) => (
            <PayoutItem key={e.key} e={e} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  );
}

function MonthList({ events, today, initialMonth, onOpen }: { events: Payout[]; today: string; initialMonth?: string; onOpen: (d: string) => void }) {
  const [open, setOpen] = useState<string | null>(initialMonth ?? null);
  const months = useMemo(() => {
    const m = new Map<string, Payout[]>();
    for (const e of events) m.set(e.date.slice(0, 7), [...(m.get(e.date.slice(0, 7)) ?? []), e]);
    return [...m.entries()];
  }, [events]);
  return (
    <div className="stack-sm">
      {months.map(([k, l]) => {
        const i = Number(k.slice(5, 7)) - 1;
        const isOpen = open === k;
        const prin = l.some((e) => e.principal > 0);
        const total = l.reduce((s, e) => s + e.amount, 0);
        return (
          <div className={`pm ${k < today.slice(0, 7) ? 'past' : ''}`} key={k}>
            <button className="pm-head" onClick={() => setOpen(isOpen ? null : k)} aria-expanded={isOpen}>
              <span className="pm-m">
                {MONTHS_SHORT[i]} ’{k.slice(2, 4)}
              </span>
              <span className="pm-bar">
                <span className="lbl">{prin ? 'Interest + Principal' : 'Interest'}</span>
                <span className="amt">{inr(total)}</span>
                <Icon name={isOpen ? 'arrow-up-s-line' : 'arrow-down-s-line'} size={18} />
              </span>
            </button>
            {isOpen && (
              <div className="pm-body">
                {l.map((e) => (
                  <PayoutItem key={e.key} e={e} onOpen={onOpen} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function PayoutItem({ e, onOpen }: { e: Payout; onOpen: (d: string) => void }) {
  return (
    <button className="pi" onClick={() => onOpen(e.date)}>
      <span className="l">
        <b>{shortDate(e.date)}</b>
        <span>
          {e.bondName.length > 18 ? `${e.bondName.slice(0, 16)}…` : e.bondName} ({e.isin.slice(-4)})
          {e.estimated ? ' · estimated' : ''}
        </span>
      </span>
      <span className="r">
        <b>{inr(e.amount)}</b>
        <span>{e.status === 'upcoming' ? (e.isFinal ? 'Interest + Principal' : e.principal ? 'Interest + Principal' : 'Interest') : <StatusBadge status={e.status} />}</span>
      </span>
    </button>
  );
}

export function PayoutSheet({ date, events, onClose, onChanged }: { date: string; events: Payout[]; onClose: () => void; onChanged: () => void }) {
  const { api, toast } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <Sheet onClose={onClose} label={`Payouts on ${formatDate(date)}`}>
      <h3 className="h-card">{formatDate(date)}</h3>
      {events.map((e) => {
        const rec = e.status === 'received';
        const canMark = e.status !== 'upcoming';
        return (
          <div className="card stack" key={e.key}>
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <b style={{ color: 'var(--text-title)' }}>{e.bondName}</b>
              <StatusBadge status={e.status} />
            </div>
            <dl className="dl">
              <dt>Portfolio</dt>
              <dd>{e.portfolioName}</dd>
              <dt>Interest</dt>
              <dd>{inr(e.interest)}</dd>
              {e.principal > 0 && (
                <>
                  <dt>Principal</dt>
                  <dd>{inr(e.principal)}</dd>
                </>
              )}
              <dt>Total, before tax</dt>
              <dd>{inr(e.amount)}</dd>
              <dt>Record date</dt>
              <dd>{formatDate(e.recordDate)}</dd>
              {e.scheduledDate !== e.date && (
                <>
                  <dt>Scheduled date</dt>
                  <dd>{formatDate(e.scheduledDate)}</dd>
                </>
              )}
            </dl>
            {e.scheduledDate !== e.date && <p className="note">Moved from {formatDate(e.scheduledDate)} because that is not a working day.</p>}
            {e.estimated && <p className="note">Estimated: worked out from details you entered or incomplete bond data.</p>}
            {canMark && (
              <button
                className={`btn btn-block ${rec ? 'btn-ghost' : 'btn-primary'}`}
                disabled={busy === e.key}
                onClick={async () => {
                  setBusy(e.key);
                  try {
                    await api.setReceived(e.holdingId, e.scheduledDate, !rec);
                    toast(rec ? 'Marked as not received' : 'Marked as received');
                    onChanged();
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {rec ? 'Undo received' : 'Mark as received'}
              </button>
            )}
          </div>
        );
      })}
      <button className="btn btn-ghost btn-block" onClick={onClose}>
        Close
      </button>
    </Sheet>
  );
}
