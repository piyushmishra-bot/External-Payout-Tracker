import { useEffect, useState, type DragEvent } from 'react';
import { formatDateNumeric, inr, pct, TEMPLATE_COLUMNS, templateFromGrid, todayIST, type TemplateMerge, type TemplateProblem, type TemplateRow } from '@eh/core';
import { SubHead, useApp, useLoad } from '../app';
import type { ReviewRow } from '../api/types';
import { downloadTemplateCsv, downloadTemplateXlsx, readTemplateFile } from '../templateFile';
import { UploadButton } from '../upload';
import { DupeChoices, Icon, ModalArt, Sheet } from '../ui';
import { TERMS_URL } from './AddFlow';
import { ManualForm, TermsCheck } from './AddPopups';

/**
 * Add holdings: choose Add manually or Upload template (ISIN, Issuer name, Units, Investment amount, Date of investment,
 * Yield), or send a file in any format for our team to add within 24 hours.
 * The file is read in the browser, then matched against the bond directory by ISIN (POST /imports/manual).
 * Bonds in the directory get their terms and payouts; others are saved with what the user gave
 * (amount, units, date, yield). The page shows a consolidated view: no coupon, maturity or payouts for now.
 * The T&C box is asked on every upload and Save stays disabled until it is ticked.
 * Rows go straight into the holding being added to. Only when a row has the same ISIN and the same date of investment
 * as a saved row does a pop-up ask: replace those saved rows with the file's rows, or save the whole file as a new
 * holding (Holding 1, Holding 2, …).
 * The same ISIN on another date is a separate purchase and is simply added.
 */
type Loaded = { name: string; importId?: string; rows: ReviewRow[]; problems: TemplateProblem[]; merged: TemplateMerge[] };

/** Remembered so the holdings page opens on the holding just saved to. */
export const ACTIVE_HOLDING_KEY = 'eh-active-holding';

export function TemplateUpload({ to, mode }: { to?: string; mode?: 'upload' | 'manual' } = {}) {
  const { api, demo, go, toast, refresh } = useApp();
  const today = demo?.today ?? todayIST();
  const ov = useLoad(() => api.overview('all'), []);
  const [file, setFile] = useState<Loaded | null>(null);
  const [reading, setReading] = useState(false);
  const [ask, setAsk] = useState(false); // pop-up: bonds already in the holding
  useEffect(() => api.trackEvent('eh_add_opened'), [api]);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  // Step 1: upload a file (several bonds) or add one bond manually.
  const [how, setHow] = useState<'upload' | 'manual'>(mode === 'manual' ? 'manual' : 'upload');
  const [err, setErr] = useState<string | null>(null);
  // Where this upload goes: ?to=<holding id>, ?to=new (Create holding), or by default the first holding.
  const creating = to === 'new';
  const holding = creating ? undefined : ov.data?.portfolios.find((p) => p.id === to) ?? ov.data?.portfolios[0];
  // What is already saved in the holding, per bond and date of investment.
  const lotKey = (isin: string, on?: string | null) => `${isin}|${on ?? ''}`;
  const saved = new Map<string, { name: string; units: number; amount?: number; on?: string }[]>();
  if (ov.data && holding)
    for (const h of [
      ...ov.data.holdings.map((h) => ({ isin: h.isin, pid: h.portfolioId, name: h.name, units: h.units, amount: h.investedAmount ?? undefined, on: h.investedOn ?? undefined })),
      ...ov.data.awaiting.map((a) => ({ isin: a.isin, pid: a.portfolioId, name: a.isin, units: a.units, amount: a.investedAmount, on: a.investedOn })),
    ])
      if (h.pid === holding.id) saved.set(lotKey(h.isin, h.on), [...(saved.get(lotKey(h.isin, h.on)) ?? []), h]);
  // Asked on every upload (not only the first time); Save stays disabled until it is ticked.
  const canSave = !!file?.importId && !!file.rows.length && agree && !busy;

  const load = async (name: string, parsed: { rows: TemplateRow[]; problems: TemplateProblem[]; merged: TemplateMerge[] }) => {
    if (file?.importId) await api.discard(file.importId).catch(() => undefined);
    let loaded: Loaded = { name, rows: [], problems: parsed.problems, merged: parsed.merged };
    if (parsed.rows.length) {
      // Match against our bond data: known bonds come back with their terms, others as "awaiting".
      const draft = await api.manual(parsed.rows.map((r) => ({ isin: r.isin, nameHint: r.issuerName, units: r.units, investedAmount: r.investedAmount, acquiredOn: r.acquiredOn, purchaseYield: r.purchaseYield })));
      loaded = { ...loaded, importId: draft.importId, rows: draft.rows };
    }
    setFile(loaded);
    setAgree(false);
  };

  const pick = async (files: File[]) => {
    setErr(null);
    setReading(true);
    try {
      const f = files[0];
      await load(f.name, await readTemplateFile(f, today));
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setReading(false);
    }
  };

  // Rows in this file already saved with the same ISIN and date of investment.
  const matches = file ? file.rows.filter((r) => saved.has(lotKey(r.isin!, r.acquiredOn))) : [];

  const save = async (how?: 'replace' | 'new') => {
    if (!file?.importId || !file.rows.length) return;
    if (!agree) return;
    if (matches.length && !how) return setAsk(true);
    setAsk(false);
    setBusy(true);
    setErr(null);
    try {
      await api.consent();
      const rows = file.rows.map((r) => ({ isin: r.isin!, units: r.units!, investedAmount: r.investedAmount, acquiredOn: r.acquiredOn, purchaseYield: r.purchaseYield, issuerName: r.nameHint, notify: r.status === 'awaiting' || undefined }));
      const res = await api.commit(file.importId, {
        rows,
        mode: 'append',
        portfolioId: how === 'new' ? undefined : holding?.id,
        newHolding: creating || how === 'new' || undefined,
        replaceLots: how === 'replace' ? matches.map((r) => ({ isin: r.isin!, acquiredOn: r.acquiredOn! })) : [],
        ownership: { kind: 'self' },
      });
      const plural = (k: number) => `${k} bond${k === 1 ? '' : 's'}`;
      const fresh = file.rows.length - matches.length;
      void plural;
      void fresh;
      toast(how === 'replace' ? 'Holdings updated' : 'Holdings added');
      try {
        sessionStorage.setItem(ACTIVE_HOLDING_KEY, res.portfolioId);
      } catch {
        /* ignore */
      }
      refresh();
      go({ name: 'external' });
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const total = file?.rows.reduce((s, r) => s + (r.investedAmount ?? 0), 0) ?? 0;
  // No. of bonds: every row being added (the same ISIN on two dates counts twice).
  const bondCount = file?.rows.length ?? 0;
  const [over, setOver] = useState(false); // a file is being dragged over the drop zone
  const [more, setMore] = useState(false); // "View more" on the combined-rows note
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const f = [...e.dataTransfer.files];
    if (f.length && !reading) pick(f.slice(0, 1));
  };
  const combined = file?.merged.reduce((n, m) => n + m.rows.length, 0) ?? 0;



  return (
    <div className="flow tpl">
      <SubHead title="Add holdings" onBack={() => go({ name: 'external' })} />

      {/* Step 1: how to add (as in the design team's wireframe) */}
      <div className="add-step">
        <span className="add-step-no">1</span>
        <h2>How would you like to add your bonds?</h2>
      </div>
      <div className="add-modes" role="radiogroup" aria-label="How would you like to add your bonds?">
        <button type="button" role="radio" aria-checked={how === 'upload'} className={`add-mode ${how === 'upload' ? 'on' : ''}`} onClick={() => setHow('upload')} data-track="add_mode_upload">
          <span className="add-mode-ic">
            <Icon name="upload-cloud-2-line" size={22} />
          </span>
          <span className="add-mode-t">
            <b>Upload a file</b>
            <span>Add many bonds at once using our Excel or CSV template.</span>
          </span>
          <span className="add-mode-radio" aria-hidden="true" />
        </button>
        <button type="button" role="radio" aria-checked={how === 'manual'} className={`add-mode ${how === 'manual' ? 'on' : ''}`} onClick={() => setHow('manual')} data-track="add_mode_manual">
          <span className="add-mode-ic">
            <Icon name="pencil-line" size={22} />
          </span>
          <span className="add-mode-t">
            <b>Enter details</b>
            <span>Add one bond by typing its details.</span>
          </span>
          <span className="add-mode-radio" aria-hidden="true" />
        </button>
      </div>

      {/* Step 2 */}
      <div className="add-step">
        <span className="add-step-no">2</span>
        <h2>{how === 'manual' ? 'Enter bond details' : 'Upload your file'}</h2>
      </div>
      {how === 'manual' ? (
        <>
          <section className="bs-card mf-card">
            <h3 className="h-card">Bond details</h3>
            <ManualForm page />
          </section>
          <section className="bs-card help-row switch-row">
            <div className="help-top">
              <span className="help-ic">
                <Icon name="upload-cloud-2-line" size={22} />
              </span>
              <span className="help-t">
                <b>Have many bonds? Upload a file instead.</b>
                <span>Download our template, add your bond details and upload the file.</span>
              </span>
              <button className="btn btn-outline help-btn" onClick={() => (setHow('upload'), window.scrollTo({ top: 0, behavior: 'smooth' }))} data-track="switch_to_upload">
                Upload a file
              </button>
            </div>
          </section>
        </>
      ) : (
        <>
      {(
      <>
      <section className="bs-card up-main">
        <div className="up-main-head">
          <h2 className="h-card">Upload your holdings</h2>
          <p>Download our template, add your bonds and upload the file.</p>
        </div>
        <div className="up-dl">
          <button className="btn btn-outline" onClick={() => (api.trackEvent('eh_template_downloaded', { format: 'xlsx' }), downloadTemplateXlsx())}>
            <Icon name="download-2-line" size={16} /> <span><span className="up-dl-w">Download </span>Excel template</span>
          </button>
          <button className="btn btn-outline" onClick={() => (api.trackEvent('eh_template_downloaded', { format: 'csv' }), downloadTemplateCsv())}>
            <Icon name="download-2-line" size={16} /> <span><span className="up-dl-w">Download </span>CSV template</span>
          </button>
        </div>
        <div className={`up-drop ${over ? 'over' : ''}`} onDragOver={(e) => (e.preventDefault(), setOver(true))} onDragLeave={() => setOver(false)} onDrop={onDrop}>
          <Icon name="upload-cloud-2-line" size={28} />
          <span className="up-drop-t trunc">{file ? file.name : 'Drag and drop your file here'}</span>
          <UploadButton track="choose_file" label={reading ? 'Reading…' : file ? 'Choose another file' : 'Choose file'} className="btn btn-primary up-choose" icon={false} accept=".xlsx,.xls,.csv,text/csv" multiple={false} onFiles={pick} />
          <span className="up-drop-hint">Excel or CSV · {TEMPLATE_COLUMNS.length} columns: {TEMPLATE_COLUMNS.map((c) => c.header.replace(/ \(.*\)$/, '')).join(', ')}</span>
        </div>
      </section>
      {!file && <AssistedCard />}
      </>
      )}

      {file && file.problems.length > 0 && (
        <div className="errb" role="alert">
          <b>
            {file.rows.length ? `${file.problems.length} row${file.problems.length === 1 ? '' : 's'} could not be added and will be skipped.` : 'We could not read any bonds from this file.'} Please correct the following and upload again:
          </b>
          <ul className="tpl-problems">
            {file.problems.map((p) => (
              <li key={`${p.row}-${p.message}`}>
                {p.row > 0 && `Row ${p.row}${p.isin ? ` (${p.isin})` : ''}: `}
                {p.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {file && file.rows.length > 0 && (
        <>
          <div className="tpl-totals">
            <div>
              <span>Total no. of bonds</span>
              <b>{bondCount}</b>
            </div>
            <div>
              <span>Total investment</span>
              <b>{inr(total)}</b>
            </div>
          </div>
          <div className="tw">
            <table className="rt tpl-rt">
              <thead>
                <tr>
                  <th>Issuer</th>
                  <th>Units</th>
                  <th>Yield</th>
                  <th>Date of investment</th>
                  <th>Investment amount</th>
                </tr>
              </thead>
              <tbody>
                {file.rows.map((r) => (
                  <tr key={r.key}>
                    <td>
                      <span className="nm trunc" title={r.bond?.name ?? r.nameHint ?? r.isin}>{r.bond?.name ?? r.nameHint ?? r.isin}</span>
                      {(r.bond?.name || r.nameHint) && <span className="isin">{r.isin}</span>}
                    </td>
                    <td>{r.units}</td>
                    <td className="green">{r.purchaseYield != null ? pct(r.purchaseYield) : '–'}</td>
                    <td className="nowrap">{r.acquiredOn ? formatDateNumeric(r.acquiredOn) : '–'}</td>
                    <td>{inr(r.investedAmount ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {file.merged.length > 0 && (
        // Short note with "View more", like the mandate note on bondscanner.com's SIP screen.
        <div className={`note-row ${more ? 'open' : ''}`} role="status">
          <Icon name="information-line" size={16} />
          <div className="note-body">
            <span>
              {combined} rows with the same ISIN and date of investment have been combined into {file.merged.length}.
            </span>
            {more && (
              <ul>
                {file.merged.map((m) => (
                  <li key={`${m.isin}-${m.acquiredOn}`}>
                    {m.isin} on {formatDateNumeric(m.acquiredOn)}: rows {m.rows.slice(0, -1).join(', ')} and {m.rows[m.rows.length - 1]}. Units and amounts have been added together, and the yield is the amount-weighted average.
                  </li>
                ))}
              </ul>
            )}
            {more && (
              <button className="link-btn" onClick={() => setMore(false)}>
                View less
              </button>
            )}
          </div>
          {!more && (
            <button className="link-btn" onClick={() => setMore(true)}>
              View more
            </button>
          )}
        </div>
      )}

          {/* Checkbox and footer as on bondscanner.com's SIP screen (checkbox icon from the design team). */}
          <label className="tnc" data-track="tnc_checkbox">
            <input type="checkbox" className="sr-only" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            <span className="tnc-box" aria-hidden="true">
              {agree ? (
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                  <path
                    d="M16.25 2.5H3.75C3.41848 2.5 3.10054 2.6317 2.86612 2.86612C2.6317 3.10054 2.5 3.41848 2.5 3.75V16.25C2.5 16.5815 2.6317 16.8995 2.86612 17.1339C3.10054 17.3683 3.41848 17.5 3.75 17.5H16.25C16.5815 17.5 16.8995 17.3683 17.1339 17.1339C17.3683 16.8995 17.5 16.5815 17.5 16.25V3.75C17.5 3.41848 17.3683 3.10054 17.1339 2.86612C16.8995 2.6317 16.5815 2.5 16.25 2.5ZM13.5672 8.56719L9.19219 12.9422C9.13414 13.0003 9.06521 13.0464 8.98934 13.0779C8.91346 13.1093 8.83213 13.1255 8.75 13.1255C8.66787 13.1255 8.58654 13.1093 8.51066 13.0779C8.43479 13.0464 8.36586 13.0003 8.30781 12.9422L6.43281 11.0672C6.31554 10.9499 6.24965 10.7909 6.24965 10.625C6.24965 10.4591 6.31554 10.3001 6.43281 10.1828C6.55009 10.0655 6.70915 9.99965 6.875 9.99965C7.04085 9.99965 7.19991 10.0655 7.31719 10.1828L8.75 11.6164L12.6828 7.68281C12.7409 7.62474 12.8098 7.57868 12.8857 7.54725C12.9616 7.51583 13.0429 7.49965 13.125 7.49965C13.2071 7.49965 13.2884 7.51583 13.3643 7.54725C13.4402 7.57868 13.5091 7.62474 13.5672 7.68281C13.6253 7.74088 13.6713 7.80982 13.7027 7.88569C13.7342 7.96156 13.7503 8.04288 13.7503 8.125C13.7503 8.20712 13.7342 8.28844 13.7027 8.36431C13.6713 8.44018 13.6253 8.50912 13.5672 8.56719Z"
                    fill="#1D4ED8"
                  />
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
          {err && (
            <span className="field-err" role="alert">
              {err}
            </span>
          )}
          <button className="btn btn-primary btn-block" disabled={!canSave} onClick={() => save()} data-track="save_bonds" title={agree ? undefined : 'Please accept the Terms & Conditions to continue'}>
            {busy ? 'Saving…' : `Save ${bondCount} bond${bondCount === 1 ? '' : 's'}`}
          </button>
        </>
      )}
      {!file && err && (
        <span className="field-err" role="alert">
          {err}
        </span>
      )}
        </>
      )}
      {ask && file && (
        <Sheet onClose={() => setAsk(false)} label="Bonds already in your holdings" className="sheet-list">
          <div className="modal-head">
            <ModalArt kind="replace" />
            <h3 className="modal-title">{matches.length === 1 ? 'This bond is' : `${matches.length} bonds are`} already in your holdings</h3>
            <p className="modal-text">You have already added {matches.length === 1 ? 'this bond' : 'these bonds'} with the same date of investment. What would you like to do?</p>
          </div>
          <ul className="match-list">
            {matches.map((r) => {
              const isin = r.isin!;
              const old = saved.get(lotKey(isin, r.acquiredOn))!;
              const neu = [r];
              const line = (x: { units?: number; amount?: number; on?: string }) =>
                [`${x.units} unit${x.units === 1 ? '' : 's'}`, x.amount != null ? inr(x.amount) : '', x.on ? formatDateNumeric(x.on) : ''].filter(Boolean).join(' · ');
              return (
                <li key={r.key}>
                  <b className="trunc">{old[0].name !== isin ? old[0].name : isin}</b>
                  {old[0].name !== isin && <span className="isin">{isin}</span>}
                  <span>
                    <span className="muted">Existing:</span> {old.map(line).join('; ')}
                  </span>
                  <span>
                    <span className="muted">New:</span> {neu.map((x) => line({ units: x.units, amount: x.investedAmount, on: x.acquiredOn })).join('; ')}
                  </span>
                </li>
              );
            })}
          </ul>
          <DupeChoices many={matches.length > 1} busy={busy} onReplace={() => save('replace')} onKeep={() => save('new')} onCancel={() => setAsk(false)} track="upload" />
        </Sheet>
      )}
    </div>
  );
}


/**
 * "Send us your holdings in any format": any file (broker statement PDF, screenshot, Excel), up to 4 MB.
 * Our team adds the holdings within 24 hours; the holdings page shows the status.
 */
function AssistedCard() {
  const { api } = useApp();
  const [f, setF] = useState<File | null>(null);
  const [note, setNote] = useState('');
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const send = async () => {
    if (!f) return;
    if (!agree) return setErr('Please accept the Terms & Conditions to continue.');
    if (f.size > 4 * 1024 * 1024) return setErr('File size must be 4 MB or less. For a larger file, please share a screenshot or split the file.');
    setBusy(true);
    setErr(null);
    try {
      await api.consent();
      await api.sendAssisted(f, note.trim() || undefined);
      setSent(true);
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (sent)
    return (
      <section className="bs-card help-row" role="status">
        <span className="help-ic ok">
          <Icon name="check-line" size={22} />
        </span>
        <span className="help-t">
          <b>File received</b>
          <span>We will add your holdings within 24 hours. You can view them on this page once added.</span>
        </span>
      </section>
    );
  return (
    <section className={`bs-card help-row ${f ? 'open' : ''}`}>
      <div className="help-top">
        <span className="help-ic">
          <Icon name="customer-service-2-line" size={22} />
        </span>
        <span className="help-t">
          <b>Can't use our template? Send us your file</b>
          <span>Share your file with us. We will add your holdings within 24 hours and notify you.</span>
        </span>
        {!f && <UploadButton track="help_send_file" label="Send a file" className="btn btn-outline help-btn" icon={false} accept="*/*" multiple={false} onFiles={(fs) => (setErr(null), setF(fs[0] ?? null))} />}
      </div>
      {f && (
        <div className="help-body">
          <span className="small file-chip">
            <Icon name="file-list-3-line" size={16} /> <span className="trunc">{f.name}</span>
            <button className="icon-btn" aria-label="Remove file" onClick={() => setF(null)}>
              <Icon name="close-line" size={16} />
            </button>
          </span>
          <input className="input" placeholder="Add a note for our team (optional)" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          <TermsCheck checked={agree} onChange={(b) => (setAgree(b), setErr(null))} track="help_tnc" />
          <button className="btn btn-primary help-send" disabled={busy || !agree} onClick={send} data-track="help_send">
            {busy ? 'Sending…' : 'Send to BondScanner'}
          </button>
          <span className="assist-fine">Broker statement, screenshot or spreadsheet · Max. 4 MB. Our team will add your holdings and update you on this page.</span>
        </div>
      )}
      {err && (
        <span className="field-err" role="alert">
          {err}
        </span>
      )}
    </section>
  );
}
