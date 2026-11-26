import { inr, MONTHS_SHORT } from '@eh/core';
import { Icon, initialsOf } from '../ui';

/** Shared pieces of BondScanner's holdings look (overview box, key/value rows, bond rows), used by the External bonds holdings page. */

/** The Overview card on BondScanner's Holdings tab. */
export function OverviewBox({ month, interest, hide, setHide, children, footer }: { month: string; interest: number; hide: boolean; setHide: (b: boolean) => void; children: React.ReactNode; footer?: React.ReactNode }) {
  const m = Number(month.slice(5, 7)) - 1;
  return (
    <section className="bs-card" aria-label="Overview">
      <div className="bs-row" style={{ alignItems: 'flex-start' }}>
        <div>
          <div className="bs-label">
            Interest <span className="dot">•</span> {MONTHS_SHORT[m]}’{month.slice(2, 4)}
          </div>
          <div className="bs-big">{hide ? '₹••••' : inr(interest)}</div>
        </div>
        <button className="sq-btn lg" onClick={() => setHide(!hide)} aria-label={hide ? 'Show amounts' : 'Hide amounts'} aria-pressed={hide}>
          <Icon name={hide ? 'eye-off-line' : 'eye-line'} size={18} />
        </button>
      </div>
      <div className="bs-kvs">{children}</div>
      {footer}
    </section>
  );
}

export function KV({ k, v, green }: { k: string; v: string; green?: boolean }) {
  return (
    <div className="bs-kv">
      <span>{k}</span>
      <b className={green ? 'green' : undefined}>{v}</b>
    </div>
  );
}

/** One row of the Investments table, as on BondScanner. */
/** Row menu button (Edit details / Remove bond); does not open the row. */
export function RowMenuBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      className="sq-btn row-menu"
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <Icon name="more-2-line" size={18} />
    </button>
  );
}

export function InvRow({ issuer, name, isin, amount, units, chevron, tag, onClick, onMenu, actions }: { issuer: string; name: string; isin: string; amount: string; units: number | string; chevron?: boolean; tag?: React.ReactNode; onClick?: () => void; onMenu?: () => void; actions?: React.ReactNode }) {
  return (
    <div className={`bs-inv ${onClick ? 'tap' : ''}`} onClick={onClick} role={onClick ? 'button' : undefined}>
      <span className="bs-logo" aria-hidden="true">
        {initialsOf(issuer)}
      </span>
      <span className="mid">
        <span className="nm">
          <span className="ell">{name}</span>
          {tag}
        </span>
        <span className="isin">{isin}</span>
      </span>
      <span className="end">
        <span className="amt">{amount}</span>
        <span className="units">({units} units)</span>
      </span>
      {actions}
      {!actions && onMenu && <RowMenuBtn label={`Options for ${name}`} onClick={onMenu} />}
      {chevron && <Icon name="arrow-right-s-line" size={20} className="chev" />}
    </div>
  );
}
