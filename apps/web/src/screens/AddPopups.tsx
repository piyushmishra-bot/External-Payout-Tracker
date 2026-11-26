import { useState } from 'react';
import { formatDateNumeric, ISSUER_NAME_MAX, isValidIsin, TEMPLATE_COLUMNS, templateFromGrid, todayIST, type TemplateKey } from '@eh/core';
import { useApp } from '../app';
import { DupeChoices, ModalArt, Sheet } from '../ui';
import { TERMS_URL } from './AddFlow';

/**
 * "+ Add holdings" anywhere on the page opens this pop-up: Add manually (a form, like Edit details) or
 * Upload holdings (the Add holdings page: template upload, or send a file in any format).
 */
export function AddChooser({ onManual, onUpload, onClose }: { onManual: () => void; onUpload: () => void; onClose: () => void }) {
  return (
    <Sheet onClose={onClose} label="Add external holdings">
      <div className="modal-head">
        <ModalArt kind="upload" />
        <h3 className="modal-title">Add external holdings</h3>
        <p className="modal-text">Track the bonds you hold on other platforms. Upload your holdings in one go, or add bonds one at a time.</p>
      </div>
      <div className="modal-actions">
        <button className="btn btn-outline" onClick={onManual} data-track="add_popup_manual">
          Enter details
        </button>
        <button className="btn btn-primary" onClick={onUpload} data-track="add_popup_upload">
          Upload a file
        </button>
      </div>
      <div className="add-foot">
        <span className="add-note">Use our Excel or CSV template, or share your own file · Max. 4 MB</span>
      </div>
    </Sheet>
  );
}

/** Add one bond by hand in a pop-up (no T&C here; the Add holdings page asks for it). */
export function ManualAdd({ onClose }: { onClose: () => void }) {
  return (
    <Sheet onClose={onClose} label="Add manually">
      <h3 className="h-card">Add manually</h3>
      <ManualForm onClose={onClose} />
    </Sheet>
  );
}

/** The T&C checkbox (checkbox icon from the design team). */
export function TermsCheck({ checked, onChange, track }: { checked: boolean; onChange: (b: boolean) => void; track?: string }) {
  return (
    <label className="tnc" data-track={track}>
      <input type="checkbox" className="sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="tnc-box" aria-hidden="true">
        {checked ? (
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M16.25 2.5H3.75C3.41848 2.5 3.10054 2.6317 2.86612 2.86612C2.6317 3.10054 2.5 3.41848 2.5 3.75V16.25C2.5 16.5815 2.6317 16.8995 2.86612 17.1339C3.10054 17.3683 3.41848 17.5 3.75 17.5H16.25C16.5815 17.5 16.8995 17.3683 17.1339 17.1339C17.3683 16.8995 17.5 16.5815 17.5 16.25V3.75C17.5 3.41848 17.3683 3.10054 17.1339 2.86612C16.8995 2.6317 16.5815 2.5 16.25 2.5ZM13.5672 8.56719L9.19219 12.9422C9.13414 13.0003 9.06521 13.0464 8.98934 13.0779C8.91346 13.1093 8.83213 13.1255 8.75 13.1255C8.66787 13.1255 8.58654 13.1093 8.51066 13.0779C8.43479 13.0464 8.36586 13.0003 8.30781 12.9422L6.43281 11.0672C6.31554 10.9499 6.24965 10.7909 6.24965 10.625C6.24965 10.4591 6.31554 10.3001 6.43281 10.1828C6.55009 10.0655 6.70915 9.99965 6.875 9.99965C7.04085 9.99965 7.19991 10.0655 7.31719 10.1828L8.75 11.6164L12.6828 7.68281C12.7409 7.62474 12.8098 7.57868 12.8857 7.54725C12.9616 7.51583 13.0429 7.49965 13.125 7.49965C13.2071 7.49965 13.2884 7.51583 13.3643 7.54725C13.4402 7.57868 13.5091 7.62474 13.5672 7.68281C13.6253 7.74088 13.6713 7.80982 13.7027 7.88569C13.7342 7.96156 13.7503 8.04288 13.7503 8.125C13.7503 8.20712 13.7342 8.28844 13.7027 8.36431C13.6713 8.44018 13.6253 8.50912 13.5672 8.56719Z" fill="#1D4ED8" />
          </svg>
        ) : (
          <span className="tnc-empty" />
        )}
      </span>
      <span>
        I have read and accept the{' '}
        <a href={TERMS_URL} target="_blank" rel="noreferrer">
          Terms &amp; Conditions
        </a>{' '}
        and authorise BondScanner to store my holdings details.
      </span>
    </label>
  );
}

/**
 * Add one bond: same fields and checks as the template; saved to the user's holdings.
 * Used in the pop-up (Cancel / Add bond) and on the Add holdings page (page: labels on the left, T&C required).
 */
export function ManualForm({ onClose, page }: { onClose?: () => void; page?: boolean }) {
  const { api, demo, toast, refresh, go } = useApp();
  const today = demo?.today ?? todayIST();
  const [v, setV] = useState({ isin: '', issuer: '', on: '', yld: '', units: '', amount: '' });
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Errors shown in red under each field.
  const [fe, setFe] = useState<Partial<Record<TemplateKey, string>>>({});
  // Same ISIN and date already saved: ask to replace it or keep both.
  const [dupe, setDupe] = useState(false);
  const FIELD: Record<keyof typeof v, TemplateKey> = { isin: 'isin', issuer: 'issuer', on: 'investedOn', yld: 'yield', units: 'units', amount: 'invested' };
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => (setDupe(false), setFe({ ...fe, [FIELD[k]]: undefined }), setV({ ...v, [k]: e.target.value }));
  const cls = (k: TemplateKey) => `input ${fe[k] ? 'err' : ''}`;
  const msg = (k: TemplateKey) =>
    fe[k] ? (
      <span className="field-err" role="alert">
        {fe[k]}
      </span>
    ) : null;
  /** Checks every field (not just the first wrong one): a field that fails is swapped for a valid example and checked again. */
  const check = () => {
    const vals = [v.isin.trim(), v.issuer, v.units, v.amount.replace(/,/g, ''), v.on ? formatDateNumeric(v.on) : '', v.yld];
    const out: Partial<Record<TemplateKey, string>> = {};
    for (let i = 0; i < TEMPLATE_COLUMNS.length; i++) {
      const p = templateFromGrid([TEMPLATE_COLUMNS.map((c) => c.header), vals], today).problems[0];
      if (!p?.field) break;
      out[p.field] = p.message;
      const ix = TEMPLATE_COLUMNS.findIndex((c) => c.key === p.field);
      vals[ix] = p.field === 'investedOn' ? formatDateNumeric(today) : TEMPLATE_COLUMNS[ix].example;
    }
    return out;
  };

  const save = async (how?: 'replace' | 'new') => {
    setErr(null);
    const errs = check();
    setFe(errs);
    if (Object.keys(errs).length) return;
    if (page && !agree) return setErr('Please accept the Terms & Conditions to continue.');
    const parsed = templateFromGrid(
      [TEMPLATE_COLUMNS.map((c) => c.header), [v.isin.trim(), v.issuer, v.units, v.amount.replace(/,/g, ''), v.on ? formatDateNumeric(v.on) : '', v.yld]],
      today,
    );
    const r = parsed.rows[0];
    setBusy(true);
    try {
      if (!how) {
        const ov = await api.overview('all');
        const first = ov.portfolios[0]?.id;
        const same = [...ov.holdings.map((h: any) => ({ pid: h.portfolioId, isin: h.isin, on: h.investedOn })), ...ov.awaiting.map((a: any) => ({ pid: a.portfolioId, isin: a.isin, on: a.investedOn }))].some(
          (x) => x.pid === first && x.isin === r.isin && x.on === r.acquiredOn,
        );
        if (same) {
          setDupe(true);
          return;
        }
      }
      await api.consent();
      const draft = await api.manual([{ isin: r.isin, nameHint: r.issuerName, units: r.units, investedAmount: r.investedAmount, acquiredOn: r.acquiredOn, purchaseYield: r.purchaseYield }]);
      const row = draft.rows[0];
      await api.commit(draft.importId, {
        rows: [{ isin: r.isin, units: r.units, investedAmount: r.investedAmount, acquiredOn: r.acquiredOn, purchaseYield: r.purchaseYield, issuerName: r.issuerName, notify: row?.status === 'awaiting' || undefined }],
        mode: 'append',
        newHolding: how === 'new' || undefined,
        replaceLots: how === 'replace' ? [{ isin: r.isin, acquiredOn: r.acquiredOn }] : [],
        ownership: { kind: 'self' },
      });
      toast(how === 'replace' ? 'Holding updated' : 'Holding added');
      refresh();
      onClose?.();
      go({ name: 'external' });
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`mf ${page ? 'mf-page' : ''}`}>
      <div className="mf-grid">
        <div className="field">
          <label htmlFor="ma-isin">ISIN</label>
          <div className="mf-in">
            <input
              id="ma-isin"
              className={cls('isin')}
              aria-invalid={!!fe.isin}
              placeholder="E.g. INE583D08081"
              autoComplete="off"
              maxLength={12}
              value={v.isin}
              onChange={(e) => (setDupe(false), setFe({ ...fe, isin: undefined }), setV({ ...v, isin: e.target.value.toUpperCase().replace(/\s/g, '') }))}
              onBlur={() => v.isin && !isValidIsin(v.isin) && setFe({ ...fe, isin: 'Please enter a valid ISIN' })}
            />
            {msg('isin')}
          </div>
        </div>
        <div className="field">
          <label htmlFor="ma-iss">Issuer name</label>
          <div className="mf-in">
            <input id="ma-iss" className={cls('issuer')} aria-invalid={!!fe.issuer} placeholder="E.g. UGRO Capital" autoComplete="off" maxLength={ISSUER_NAME_MAX} value={v.issuer} onChange={set('issuer')} />
            {msg('issuer')}
          </div>
        </div>
        <div className="field">
          <label htmlFor="ma-units">Units</label>
          <div className="mf-in">
            <input id="ma-units" className={cls('units')} aria-invalid={!!fe.units} inputMode="numeric" placeholder="Enter number of units" value={v.units} onChange={set('units')} />
            {msg('units')}
          </div>
        </div>
        <div className="field">
          <label htmlFor="ma-amt">Investment amount</label>
          <div className="mf-in">
            <span className="adorn">
              <span className="adorn-pre" aria-hidden="true">
                ₹
              </span>
              <input id="ma-amt" className={cls('invested')} aria-invalid={!!fe.invested} inputMode="decimal" placeholder="Enter amount" value={v.amount} onChange={set('amount')} />
            </span>
            {msg('invested')}
          </div>
        </div>
        <div className="field">
          <label htmlFor="ma-on">Date of investment</label>
          <div className="mf-in">
            <input id="ma-on" className={cls('investedOn')} aria-invalid={!!fe.investedOn} type="date" max={today} value={v.on} onChange={set('on')} />
            {msg('investedOn')}
          </div>
        </div>
        <div className="field">
          <label htmlFor="ma-yld">Yield</label>
          <div className="mf-in">
            <span className="adorn">
              <input id="ma-yld" className={cls('yield')} aria-invalid={!!fe.yield} inputMode="decimal" placeholder="E.g. 10.5" value={v.yld} onChange={set('yld')} />
              <span className="adorn-post" aria-hidden="true">
                %
              </span>
            </span>
            {msg('yield')}
          </div>
        </div>
      </div>
      {page && <TermsCheck checked={agree} onChange={(b) => (setAgree(b), setErr(null))} track="manual_tnc" />}
      {err && (
        <span className="field-err" role="alert">
          {err}
        </span>
      )}
      {dupe ? (
        <>
          <div className="dupe-head" role="status">
            <b>This bond is already in your holdings</b>
            <span>You have already added this bond with the same date of investment. What would you like to do?</span>
          </div>
          <DupeChoices many={false} busy={busy} onReplace={() => save('replace')} onKeep={() => save('new')} onCancel={() => setDupe(false)} track="manual" />
        </>
      ) : page ? (
        <div className="mf-actions">
          <button className="btn btn-primary mf-add" onClick={() => save()} disabled={busy || !agree} data-track="manual_add_bond_page">
            {busy ? 'Saving…' : 'Add bond'}
          </button>
        </div>
      ) : (
        <div className="modal-actions">
          <button className="btn btn-outline" onClick={onClose} disabled={busy} data-track="manual_cancel">
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => save()} disabled={busy} data-track="manual_add_bond">
            {busy ? 'Saving…' : 'Add bond'}
          </button>
        </div>
      )}
    </div>
  );
}
