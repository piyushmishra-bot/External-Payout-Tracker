import { useEffect, useMemo, useRef, useState } from 'react';
import { diffDays, formatDate, formatDateNumeric, FREQUENCY_LABEL, inr, ISSUER_NAME_MAX, isValidIsin, MONTHS_LONG, normaliseIsin, validateCustomTerms, type CustomTerms } from '@eh/core';
import { SubHead, useApp } from '../app';
import { BLOCKING, type BondHit, type CommitBody, type CommitResult, type DraftRow, type FileResult, type Investment, type MatchInfo, type OwnershipInfo, type ReviewResult, type ReviewRow } from '../api/types';
import { Icon, Sheet, Stepper, useCountUp } from '../ui';
import { MAX_FILES, UploadButton } from '../upload';

interface PickedFile {
  file: File;
  password: string;
  status?: FileResult['status'];
  message?: string;
}
/** Add manually: ISIN, date of investment, units, invested amount, yield. Bond terms come from the ISIN. */
interface ManualBond {
  isin: string;
  units: number;
  investedOn: string;
  investedAmount: number;
  purchaseYield: number;
  /** Set when our data has the ISIN. */
  known?: BondHit;
}

const draftOf = (r: ReviewRow): DraftRow => ({ key: r.key, isin: r.isin, units: r.units, acquiredOn: r.acquiredOn, investedAmount: r.investedAmount, purchaseYield: r.purchaseYield, nameHint: r.nameHint, confidence: r.confidence, customTerms: r.customTerms, notify: r.notify, ok: r.ok, files: r.files });

function mergeRows(current: DraftRow[], incoming: DraftRow[]): DraftRow[] {
  const out = current.map((r) => ({ ...r }));
  for (const r of incoming) {
    const prev = r.isin ? out.find((x) => x.isin === r.isin) : undefined;
    if (prev) {
      prev.units = (prev.units ?? 0) + (r.units ?? 0) || undefined;
      prev.files = [...new Set([...(prev.files ?? []), ...(r.files ?? [])])];
      prev.customTerms = prev.customTerms ?? r.customTerms;
    } else out.push(r);
  }
  return out;
}

/**
 * Flow (agreed 18 Nov 2026):
 *  Holdings CTA → Add (upload first; "Add manually" toggle) → Check (fix / Notify me /
 *  Add details) → Wow (auto, ~2.5 s) → External Holdings.
 */
export function AddFlow() {
  const { api, go, toast, refresh } = useApp();
  const [phase, setPhase] = useState<'add' | 'reading' | 'check' | 'wow'>('add');
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [manual, setManual] = useState<ManualBond[]>([]);
  const [consent, setConsent] = useState(false);
  const [importIds, setImportIds] = useState<string[]>([]);
  const [check, setCheck] = useState<ReviewResult | null>(null);
  const [skipped, setSkipped] = useState(0);
  const [statementDate, setStatementDate] = useState<string | null>(null);
  const [result, setResult] = useState<CommitResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [removedFiles, setRemovedFiles] = useState<string[]>([]);
  const rows = check?.rows ?? [];
  const mainId = importIds[0];

  useEffect(() => {
    api.status().then((s) => setConsent(s.consented));
    // "Continue where you left off"
    api.pendingImport().then(async (p) => {
      if (!p) return;
      setImportIds([p.importId]);
      setStatementDate(p.statementDate);
      setCheck(await api.review(p.importId, p.rows.map(draftOf)));
      setPhase('check');
    });
  }, [api]);

  // Demo only: "Demo files" buttons stand in for the phone's file picker.
  useEffect(() => {
    const on = (e: Event) => {
      const name = (e as CustomEvent<string>).detail;
      setFiles((fs) => (fs.length >= MAX_FILES || fs.some((f) => f.file.name === name) ? fs : [...fs, { file: new File(['demo'], name), password: '' }]));
    };
    window.addEventListener('eh-demo-file', on);
    return () => window.removeEventListener('eh-demo-file', on);
  }, []);

  /** Read the chosen files and manual bonds, then go to the check screen. */
  const read = async (only?: PickedFile[]) => {
    setError(null);
    const list = only ?? files;
    if (!only) setPhase('reading');
    else setWorking(true);
    try {
      const ids = [...importIds];
      let next: DraftRow[] = only ? rows.map(draftOf) : [];
      if (list.length) {
        const d = await api.uploadFiles(list.map((f) => ({ file: f.file, password: f.password || undefined })));
        ids.push(d.importId);
        next = mergeRows(next, d.rows.map(draftOf));
        setSkipped((n) => (only ? n : 0) + d.skipped.length);
        if (d.statementDate) setStatementDate(d.statementDate);
        setFiles((fs) => fs.map((f) => {
          const r = d.files.find((x) => x.filename === f.file.name);
          return r ? { ...f, status: r.status, message: r.message } : f;
        }));
      }
      if (!only && manual.length) {
        const m = await api.manual(manual.map((b) => ({ isin: b.isin, units: b.units, acquiredOn: b.investedOn, investedAmount: b.investedAmount, purchaseYield: b.purchaseYield })));
        ids.push(m.importId);
        next = mergeRows(next, m.rows.map(draftOf));
      }
      if (!ids.length) return setPhase('add');
      setImportIds(ids);
      if (!next.length && !only) {
        // Nothing usable: stay on the Add page; each file's own problem shows at the bottom.
        setPhase('add');
        if (!list.length) setError('No bonds were found. Upload another statement or add bonds manually.');
        return;
      }
      setCheck(await api.review(ids[0], next, { alsoImportIds: ids.slice(1), removedFiles }));
      setPhase('check');
    } catch (e) {
      setError((e as Error).message);
      setPhase(only ? 'check' : 'add');
    } finally {
      setWorking(false);
    }
  };

  const leave = () => {
    for (const id of importIds) api.discard(id).catch(() => undefined);
    go({ name: 'external' });
  };

  if (phase === 'reading') return <Busy onCancel={() => setPhase('add')} />;
  if (phase === 'wow' && result) return <Wow r={result} onDone={() => go({ name: 'external' })} />;
  if (phase === 'check' && check)
    return (
      <CheckStep
        rows={rows}
        check={check}
        files={files}
        setFiles={setFiles}
        skipped={skipped}
        statementDate={statementDate}
        error={error}
        working={working}
        onUpdate={async (next) => {
          setError(null);
          try {
            setCheck(await api.review(mainId, next, { alsoImportIds: importIds.slice(1), removedFiles }));
          } catch (e) {
            setError((e as Error).message);
          }
        }}
        consented={consent}
        onConsent={async () => {
          await api.consent();
          setConsent(true);
        }}
        onUnlock={(f) => read([f])}
        onRemoveFile={async (name) => {
          // Drop the file and the bonds that came only from it.
          const gone = [...removedFiles, name];
          setRemovedFiles(gone);
          const next = rows.filter((r) => !r.files?.length || r.files.some((f) => !gone.includes(f))).map(draftOf);
          setError(null);
          try {
            setCheck(await api.review(mainId, next, { alsoImportIds: importIds.slice(1), removedFiles: gone }));
          } catch (e) {
            setError((e as Error).message);
          }
        }}
        onBack={() => {
          for (const id of importIds) api.discard(id).catch(() => undefined);
          setImportIds([]);
          setRemovedFiles([]);
          setCheck(null);
          setPhase('add');
        }}
        onCommit={async (body) => {
          const r = await api.commit(mainId, {
            ...body,
            rows: rows.map((x) => ({ isin: x.isin!, units: x.units!, acquiredOn: x.acquiredOn, investedAmount: x.investedAmount, purchaseYield: x.purchaseYield, customTerms: x.bond ? undefined : x.customTerms, notify: x.status === 'awaiting' || undefined })),
            alsoImportIds: importIds.slice(1),
            removedFiles,
          });
          refresh();
          if (body.mode === 'new') {
            setResult(r);
            setPhase('wow');
          } else {
            toast(body.mode === 'add_new_only' ? `Added ${r.added} new ${r.added === 1 ? 'bond' : 'bonds'} to ${r.name}` : `Updated ${r.name}: ${r.added} new, ${r.sold} sold`);
            go({ name: 'external' });
          }
        }}
        onKeep={() => {
          leave();
          toast('No changes. Your holdings are already up to date.');
        }}
      />
    );

  const canRead = files.length > 0 || manual.length > 0;
  return (
    <div className="flow">
      <FlowHead title="Add your holdings" onBack={() => go({ name: 'external' })} />
      <UploadSection files={files} setFiles={setFiles} />
      <ManualSection bonds={manual} setBonds={setManual} />
      <div className="flow-foot">
        {files
          .filter((f) => f.status && f.status !== 'read')
          .map((f) => (
            <div key={f.file.name} className="errb" role="alert">
              <b>{f.file.name}:</b> {f.message}
            </div>
          ))}
        {error && (
          <div className="errb" role="alert">
            {error}
          </div>
        )}
        <button className="btn btn-primary btn-block" disabled={!canRead} onClick={() => read()}>
          {files.length ? 'Continue' : 'Continue'}
        </button>
      </div>
    </div>
  );
}

function UploadSection({ files, setFiles }: { files: PickedFile[]; setFiles: (f: PickedFile[]) => void }) {
  const { demo } = useApp();
  const add = (list: File[]) => {
    const next = [...files];
    for (const f of list) if (next.length < MAX_FILES && !next.some((x) => x.file.name === f.name)) next.push({ file: f, password: '' });
    setFiles(next);
  };
  return (
    <>
      <div className="drop">
        <span className="ic">
          <Icon name="upload-cloud-2-line" size={24} />
        </span>
        <b style={{ color: 'var(--text-title)', fontSize: 16 }}>Upload holdings statement</b>
        <span className="small muted">CDSL/NSDL statement (CAS), a holdings PDF or Excel from your platform, or a screenshot. Up to {MAX_FILES} files.</span>
        {files.length < MAX_FILES && <UploadButton label={files.length ? 'Add more files' : 'Choose files'} className="btn btn-primary btn-sm" onFiles={add} icon={false} />}
        <div className="formats">
          <span>
            <Icon name="file-pdf-2-line" size={16} />
            PDF
          </span>
          <span>
            <Icon name="file-excel-2-line" size={16} />
            Excel, CSV
          </span>
          <span>
            <Icon name="image-line" size={16} />
            Screenshot
          </span>
        </div>
      </div>
      {demo && <p className="note">Demo: the “Demo files” buttons at the top stand in for the phone’s file picker. CSV files are read for real.</p>}
      {files.length > 0 && (
        <div className="stack-sm">
          {files.map((f) => {
            const pdf = /\.pdf$/i.test(f.file.name);
            return (
              <div className="card stack-sm" key={f.file.name} style={{ padding: 12 }}>
                <div className="row">
                  <span className="row" style={{ justifyContent: 'flex-start', minWidth: 0, gap: 10 }}>
                    <Icon name={pdf ? 'file-pdf-2-line' : /\.(xlsx|csv)$/i.test(f.file.name) ? 'file-excel-2-line' : 'image-line'} />
                    <b style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.file.name}</b>
                  </span>
                  <button className="link danger" onClick={() => setFiles(files.filter((x) => x.file.name !== f.file.name))}>
                    Remove
                  </button>
                </div>
                {pdf && (
                  <input
                    className={`input ${f.status === 'password_required' || f.status === 'password_incorrect' ? 'err' : ''}`}
                    type="password"
                    autoComplete="off"
                    placeholder="PDF password, if any (for CAS, your PAN in capitals)"
                    aria-label={`Password for ${f.file.name}`}
                    value={f.password}
                    onChange={(e) => setFiles(files.map((x) => (x.file.name === f.file.name ? { ...x, password: e.target.value } : x)))}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

const pad = (n: number) => String(n).padStart(2, '0');
const FREQS: CustomTerms['frequency'][] = [12, 4, 2, 1];

/** Maturity date as Day / Month / Year dropdowns (no browser date picker). */
function DateSelects({ value, onChange, bad }: { value: string; onChange: (v: string) => void; bad?: boolean }) {
  const [y, m, d] = value ? value.split('-') : ['', '', ''];
  const y0 = new Date().getFullYear();
  const set = (yy: string, mm: string, dd: string) => onChange(yy && mm && dd ? `${yy}-${mm}-${dd}` : `${yy}-${mm}-${dd}`.replace(/^--$/, ''));
  return (
    <div className="d3">
      <select className={`input ${bad && !d ? 'err' : ''}`} aria-label="Day" value={d} onChange={(e) => set(y, m, e.target.value)}>
        <option value="">Day</option>
        {Array.from({ length: 31 }, (_, i) => (
          <option key={i} value={pad(i + 1)}>
            {i + 1}
          </option>
        ))}
      </select>
      <select className={`input ${bad && !m ? 'err' : ''}`} aria-label="Month" value={m} onChange={(e) => set(y, e.target.value, d)}>
        <option value="">Month</option>
        {MONTHS_LONG.map((mm, i) => (
          <option key={mm} value={pad(i + 1)}>
            {mm}
          </option>
        ))}
      </select>
      <select className={`input ${bad && !y ? 'err' : ''}`} aria-label="Year" value={y} onChange={(e) => set(e.target.value, m, d)}>
        <option value="">Year</option>
        {Array.from({ length: 31 }, (_, i) => (
          <option key={i} value={y0 + i}>
            {y0 + i}
          </option>
        ))}
      </select>
    </div>
  );
}

/** The bond-terms fields shared by "Add manually" and "Add details". Missing ones are highlighted. */
function TermsFields({ t, set, show }: { t: Partial<CustomTerms>; set: (p: Partial<CustomTerms>) => void; show: boolean }) {
  // Keep what the user typed as text, so "9." or "9.2" stays while typing a decimal.
  const [coupon, setCoupon] = useState(t.couponRate != null ? String(t.couponRate) : '');
  const [face, setFace] = useState(t.faceValue != null ? String(t.faceValue) : '');
  return (
    <>
      <div className="grid2">
        <div className="field">
          <label>Coupon rate (% a year)</label>
          <input
            className={`input ${show && !t.couponRate ? 'err' : ''}`}
            type="text"
            inputMode="decimal"
            placeholder="Eg. 9.25"
            value={coupon}
            onChange={(e) => {
              const v = e.target.value.replace(',', '.').replace(/[^\d.]/g, '');
              if (!/^\d{0,3}(\.\d{0,4})?$/.test(v)) return;
              setCoupon(v);
              set({ couponRate: parseFloat(v) > 0 ? parseFloat(v) : undefined });
            }}
          />
        </div>
        <div className="field">
          <label>Interest paid</label>
          <select className={`input ${show && !t.frequency ? 'err' : ''}`} value={t.frequency ?? ''} onChange={(e) => set({ frequency: (Number(e.target.value) || undefined) as CustomTerms['frequency'] })}>
            <option value="">Choose</option>
            {FREQS.map((f) => (
              <option key={f} value={f}>
                {FREQUENCY_LABEL[f]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label>Maturity date</label>
        <DateSelects value={t.maturityDate ?? ''} onChange={(v) => set({ maturityDate: v })} bad={show} />
      </div>
      <div className="field">
        <label>Face value per unit (₹)</label>
        <input
          className={`input ${show && !t.faceValue ? 'err' : ''}`}
          type="text"
          inputMode="decimal"
          placeholder="Eg. 1000"
          value={face}
          onChange={(e) => {
            const v = e.target.value.replace(/,/g, '').replace(/[^\d.]/g, '');
            if (!/^\d{0,9}(\.\d{0,2})?$/.test(v)) return;
            setFace(v);
            set({ faceValue: parseFloat(v) > 0 ? parseFloat(v) : undefined });
          }}
        />
      </div>
    </>
  );
}

/** "Add manually": ISIN, quantity, maturity date, coupon rate. Verified later from Deridata. */
function ManualSection({ bonds, setBonds }: { bonds: ManualBond[]; setBonds: (b: ManualBond[]) => void }) {
  const { api, demo } = useApp();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<BondHit[]>([]);
  const [known, setKnown] = useState<BondHit | null>(null);
  const [units, setUnits] = useState('');
  const [on, setOn] = useState('');
  const [amount, setAmount] = useState('');
  const [yld, setYld] = useState('');
  const [show, setShow] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const today = demo?.today ?? new Date().toISOString().slice(0, 10);
  const isin = known?.isin ?? normaliseIsin(q);
  const nUnits = Number(units);
  const nAmount = Number(amount);
  const nYield = Number(yld);
  useEffect(() => {
    if (known || q.trim().length < 2) return setHits([]);
    const tm = setTimeout(() => api.searchBonds(q.trim()).then(setHits).catch(() => setHits([])), 200);
    return () => clearTimeout(tm);
  }, [q, known, api]);
  // A typed ISIN that is in our data: show what we know about it.
  useEffect(() => {
    if (!known && isValidIsin(isin)) api.searchBonds(isin).then((r) => r[0]?.isin === isin && setKnown(r[0])).catch(() => undefined);
  }, [isin, known, api]);

  const bad = {
    isin: !isValidIsin(isin),
    on: !on || on > today,
    units: !(Number.isInteger(nUnits) && nUnits > 0),
    amount: !(nAmount > 0),
    yld: !(yld !== '' && nYield >= 0 && nYield <= 50),
  };
  const reset = () => {
    setQ('');
    setKnown(null);
    setUnits('');
    setOn('');
    setAmount('');
    setYld('');
    setShow(false);
    setErr(null);
  };
  const add = () => {
    setShow(true);
    if (bad.isin) return setErr('Enter a valid 12-character ISIN.');
    if (bad.on) return setErr('Enter the date of investment. It cannot be in the future.');
    if (bad.units) return setErr('Enter the number of units as a whole number.');
    if (bad.amount) return setErr('Enter the amount invested.');
    if (bad.yld) return setErr('Enter the yield at purchase, between 0% and 50%.');
    setBonds([...bonds.filter((b) => b.isin !== isin), { isin, units: nUnits, investedOn: on, investedAmount: nAmount, purchaseYield: nYield, known: known ?? undefined }]);
    reset();
  };
  const cls = (b: boolean) => `input ${show && b ? 'err' : ''}`;
  const num = (set: (v: string) => void, decimals: number) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value.replace(/,/g, '').replace(/[^\d.]/g, '');
    if (new RegExp(`^\\d{0,10}(\\.\\d{0,${decimals}})?$`).test(v)) set(v);
  };

  return (
    <section className="card stack">
      <button className="row" style={{ border: 0, background: 'none', padding: 0, textAlign: 'left' }} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="row" style={{ justifyContent: 'flex-start', gap: 10 }}>
          <span className="perk">
            <span className="ic">
              <Icon name="keyboard-line" />
            </span>
          </span>
          <span>
            <b className="h-card" style={{ fontSize: 16, display: 'block' }}>
              Add manually
            </b>
            <span className="small subtle">ISIN, date of investment, units, amount and yield</span>
          </span>
        </span>
        <span role="switch" aria-checked={open} className={`switch ${open ? 'on' : ''}`}>
          <i />
        </span>
      </button>
      {open && (
        <>
          <div className="field">
            <label htmlFor="mi">ISIN</label>
            <input id="mi" className={cls(bad.isin)} autoComplete="off" placeholder="Eg. INE0AST07019, or search by issuer name" value={known ? `${known.name} · ${known.isin}` : q} onChange={(e) => (setQ(e.target.value), setKnown(null))} />
            {known && (
              <span className="hint">
                {known.couponRate}% coupon · {FREQUENCY_LABEL[known.frequency]} · matures {formatDateNumeric(known.maturityDate)}
              </span>
            )}
          </div>
          {hits.length > 0 && !known && (
            <div className="sugg" role="listbox" aria-label="Matching bonds">
              {hits.map((h) => (
                <button key={h.isin} role="option" aria-selected={false} onClick={() => (setKnown(h), setHits([]))}>
                  <span>
                    <b style={{ fontWeight: 500 }}>{h.name}</b>
                    <span className="small subtle" style={{ display: 'block' }}>
                      {h.isin}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
          <div className="grid2">
            <div className="field">
              <label htmlFor="mdate">Date of investment</label>
              <input id="mdate" type="date" className={cls(bad.on)} max={today} value={on} onChange={(e) => setOn(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="mu">Units</label>
              <input id="mu" className={cls(bad.units)} inputMode="numeric" placeholder="Eg. 5" value={units} onChange={(e) => setUnits(e.target.value.replace(/[^\d]/g, ''))} />
            </div>
          </div>
          <div className="grid2">
            <div className="field">
              <label htmlFor="mamt">Invested amount (₹)</label>
              <input id="mamt" className={cls(bad.amount)} inputMode="decimal" placeholder="Eg. 50,250" value={amount} onChange={num(setAmount, 2)} />
            </div>
            <div className="field">
              <label htmlFor="myld">Yield (% p.a.)</label>
              <input id="myld" className={cls(bad.yld)} inputMode="decimal" placeholder="Eg. 10.25" value={yld} onChange={num(setYld, 3)} />
            </div>
          </div>
          {err && <div className="errb">{err}</div>}
          <button className="btn btn-soft btn-block" onClick={add}>
            <Icon name="add-line" size={18} /> Add bond
          </button>
        </>
      )}
      {bonds.length > 0 && (
        <div className="stack-sm">
          <div className="overline">Added manually ({bonds.length})</div>
          {bonds.map((b) => (
            <div className="row" key={b.isin}>
              <span style={{ minWidth: 0 }}>
                <b style={{ fontWeight: 500, display: 'block' }}>{b.known?.name ?? b.isin}</b>
                <span className="small subtle">
                  {b.isin} · {b.units} units · {inr(b.investedAmount)} on {formatDateNumeric(b.investedOn)} · {b.purchaseYield}% yield
                </span>
              </span>
              <button className="iconbtn" aria-label={`Remove ${b.isin}`} onClick={() => setBonds(bonds.filter((x) => x.isin !== b.isin))}>
                <Icon name="delete-bin-line" size={18} />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function FlowHead({ title, onBack }: { title: string; onBack?: () => void }) {
  return <SubHead title={title} onBack={onBack} />;
}

function Busy({ onCancel }: { onCancel: () => void }) {
  const [step, setStep] = useState(1);
  useEffect(() => {
    const ts = [2, 3].map((n, i) => window.setTimeout(() => setStep(n), 700 * (i + 1)));
    return () => ts.forEach(clearTimeout);
  }, []);
  const steps = ['Opening files', 'Finding ISINs and units', 'Matching with exchange bond data', 'Calculating payouts'];
  return (
    <div className="flow" aria-live="polite">
      <FlowHead title="Reading your holdings" />
      <div className="card pad-lg stack" style={{ gap: 20, marginTop: 24 }}>
        <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={4} aria-valuenow={step}>
          <i style={{ width: `${step * 25}%` }} />
        </div>
        <div className="checklist">
          {steps.map((s, i) => (
            <div key={s} className={`it ${step > i ? 'done' : ''}`}>
              <span className="tick">{step > i && <Icon name="check-line" size={14} />}</span>
              {s}
            </div>
          ))}
        </div>
        <p className="note">Files are deleted once they are read.</p>
      </div>
      <div className="flow-foot">
        <button className="btn btn-ghost btn-block" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function totalsOf(rows: ReviewRow[], today: string) {
  let principal = 0;
  let interest = 0;
  for (const r of rows) {
    if (!r.units || BLOCKING.includes(r.status) || r.status === 'awaiting') continue;
    const t = r.bond ?? r.customTerms;
    if (!t) continue;
    const fv = r.units * t.faceValue;
    principal += fv;
    interest += (fv * t.couponRate * Math.max(0, diffDays(today, t.maturityDate))) / 36500;
  }
  return { principal, total: principal + interest };
}

/** Statement in someone else's name (or no PAN found): allow, with a warning and a confirmation. */
function OwnerBlock({
  own,
  owner,
  setOwner,
  label,
  setLabel,
  onRemoveFile,
  busy,
}: {
  own: OwnershipInfo;
  owner: 'self' | 'family' | null;
  setOwner: (o: 'self' | 'family' | null) => void;
  label: string;
  setLabel: (s: string) => void;
  onRemoveFile: (name: string) => void;
  busy: boolean;
}) {
  const others = own.files.filter((f) => f.owner === 'other');
  const labelInput = (
    <input className="input" placeholder="Whose holdings? Eg. Dad" aria-label="Whose holdings" maxLength={40} value={label} onChange={(e) => setLabel(e.target.value)} />
  );
  if (own.overall === 'other')
    return (
      <div className="warnb stack-sm" role="alert">
        {others.map((f) => (
          <div key={f.filename} className="stack-sm">
            <span>
              <b>{f.filename}</b> is in someone else’s name{f.pan ? ` (PAN ${f.pan}${f.holder ? `, ${f.holder}` : ''})` : ''}, not yours.
            </span>
            <button className="link" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={() => onRemoveFile(f.filename)}>
              Remove this file
            </button>
          </div>
        ))}
        <label className="consent-box">
          <input type="checkbox" checked={owner === 'family'} onChange={(e) => setOwner(e.target.checked ? 'family' : null)} />
          <span className="small">It’s a family member’s and I have their permission to track it here. It will be kept as a separate holding.</span>
        </label>
        {owner === 'family' && labelInput}
      </div>
    );
  return (
    <div className="infob stack-sm">
      <span>We couldn’t find a PAN in these holdings. Whose are they?</span>
      <div className="row" style={{ gap: 8 }}>
        <button className={`btn btn-sm ${owner === 'self' ? 'btn-primary' : 'btn-outline'}`} aria-pressed={owner === 'self'} onClick={() => setOwner('self')}>
          Mine
        </button>
        <button className={`btn btn-sm ${owner === 'family' ? 'btn-primary' : 'btn-outline'}`} aria-pressed={owner === 'family'} onClick={() => setOwner('family')}>
          A family member’s
        </button>
      </div>
      {owner === 'family' && (
        <>
          {labelInput}
          <span className="small">Only add them if you have their permission.</span>
        </>
      )}
    </div>
  );
}

/** BondScanner's live Terms and Privacy pages (bondscanner.com footer). */
export const TERMS_URL = 'https://bondscanner.com/terms-and-conditions';
export const PRIVACY_URL = 'https://bondscanner.com/privacy-policy';

/** Plain-language summary behind "What we keep". Copy to be signed off by compliance. */
function KeepSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet onClose={onClose} label="What we keep">
      <h3 className="h-card">Data we store</h3>
      <dl className="keep">
        <dt>What we store</dt>
        <dd>The bonds you confirm: ISIN, units, date of investment, invested amount, yield, bond terms (coupon, maturity, payout dates), statement date and holding name.</dd>
        <dt>Why</dt>
        <dd>To display your holdings, payout calendar and portfolio report, and to send payout and maturity reminders.</dd>
        <dt>What we do not store</dt>
        <dd>Uploaded files are deleted after reading. PDF passwords are never stored.</dd>
        <dt>Your control</dt>
        <dd>You can delete a holding at any time from External holdings (⋮ → Delete). Its bonds, payouts and reminders are removed with it.</dd>
      </dl>
      <p className="note">
        Full details in our{' '}
        <a href={TERMS_URL} target="_blank" rel="noreferrer">
          Terms
        </a>{' '}
        and{' '}
        <a href={PRIVACY_URL} target="_blank" rel="noreferrer">
          Privacy Policy
        </a>
        .
      </p>
      <button className="btn btn-primary btn-block" onClick={onClose}>
        Got it
      </button>
    </Sheet>
  );
}

function CheckStep({
  rows,
  check,
  files,
  setFiles,
  skipped,
  statementDate,
  error,
  working,
  onUpdate,
  consented,
  onConsent,
  onUnlock,
  onRemoveFile,
  onBack,
  onCommit,
  onKeep,
}: {
  rows: ReviewRow[];
  check: ReviewResult;
  files: PickedFile[];
  setFiles: (f: PickedFile[]) => void;
  skipped: number;
  statementDate: string | null;
  error: string | null;
  working: boolean;
  onUpdate: (next: DraftRow[]) => void;
  consented: boolean;
  onConsent: () => Promise<void>;
  onUnlock: (f: PickedFile) => void;
  onRemoveFile: (name: string) => void;
  onBack: () => void;
  onCommit: (b: Omit<CommitBody, 'rows'>) => Promise<void>;
  onKeep: () => void;
}) {
  const { demo } = useApp();
  const [showAll, setShowAll] = useState(false);
  const [fixKey, setFixKey] = useState<string | null>(null);
  const [match, setMatch] = useState<MatchInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Whose holdings: needed when a statement is in someone else's name, or no PAN was found.
  const [agree, setAgree] = useState(false);
  const [terms, setTerms] = useState(false);
  const agreed = consented || agree;
  const [owner, setOwner] = useState<'self' | 'family' | null>(null);
  const [ownerLabel, setOwnerLabel] = useState('');
  const own = check.ownership;
  const needsOwner = !!own?.enabled && own.overall !== 'self';
  const ownerKind = own.overall === 'other' ? (owner === 'family' ? 'family' : null) : owner;
  const ownerOk = !needsOwner || (ownerKind != null && (ownerKind === 'self' || ownerLabel.trim().length > 0));
  const ownership = needsOwner && ownerKind ? { kind: ownerKind, label: ownerKind === 'family' ? ownerLabel.trim() : undefined } : undefined;
  const today = demo?.today ?? new Date().toISOString().slice(0, 10);
  const blocked = rows.filter((r) => BLOCKING.includes(r.status));
  const attention = rows.filter((r) => r.status !== 'ready' || (r.alreadyIn?.length ?? 0) > 0);
  const ready = rows.filter((r) => r.status === 'ready' || r.status === 'your_details');
  const shown = showAll ? rows : attention;
  const totals = useMemo(() => totalsOf(rows, today), [rows, today]);
  const patch = (key: string, p: Partial<DraftRow>) => onUpdate(rows.map((r) => (r.key === key ? { ...draftOf(r), ...p } : draftOf(r))));
  const remove = (key: string) => onUpdate(rows.filter((r) => r.key !== key).map(draftOf));
  const fileProblems = files.filter((f) => f.status && f.status !== 'read');
  const commit = async (b: Omit<CommitBody, 'rows'>) => {
    setBusy(true);
    setErr(null);
    try {
      if (!consented) await onConsent();
      await onCommit({ ...b, ownership });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const awaitingN = rows.filter((r) => r.status === 'awaiting').length;
  const reviewN = attention.filter((r) => !['ready', 'your_details', 'awaiting'].includes(r.status)).length;
  const heading = blocked.length
    ? 'Some bonds need attention'
    : reviewN
      ? 'Please review these bonds'
      : awaitingN === rows.length
        ? 'Bond details will be fetched'
        : awaitingN
          ? 'Bonds matched, some details pending'
          : 'All bonds matched';
  const fixRow = rows.find((r) => r.key === fixKey);

  return (
    <div className="flow">
      <FlowHead title="Confirm your holdings" onBack={onBack} />
      <div>
        <h2 className="h-section">{heading}</h2>
        <p className="p muted">
          Found <b style={{ color: 'var(--text-title)' }}>{rows.length === 1 ? '1 bond' : `${rows.length} bonds`}</b>
          {blocked.length ? ` · ${blocked.length} to fix before saving` : ''}. Nothing is saved until you confirm.
          {awaitingN > 0 && ` ${awaitingN === 1 ? 'One bond is' : `${awaitingN} bonds are`} not yet in our records; details will be fetched automatically and totals updated.`}
        </p>
      </div>
      <div className="preview">
        <div className="card">
          <div className="overline">Total investment</div>
          <div className="val">{(() => {
            const pending = rows.filter((r) => r.status === 'awaiting').reduce((a, r) => a + (r.investedAmount ?? 0), 0);
            const t = (ready.length ? totals.principal : 0) + pending;
            return t > 0 ? inr(Math.round(t)) : '–';
          })()}</div>
        </div>
        <div className="card">
          <div className="overline">Total expected amount</div>
          <div className="val" style={{ color: 'var(--yield)' }}>
            {ready.length ? inr(Math.round(totals.total)) : '–'}
          </div>
        </div>
      </div>
      <div className="row small">
        {ready.length > 0 && <span className="badge b-success">Matched {ready.length}</span>}
        {awaitingN > 0 && <span className="badge b-info">Details awaited {awaitingN}</span>}
        {reviewN > 0 && <span className="badge b-warning">Need attention {reviewN}</span>}
        <span style={{ flex: 1 }} />
        {rows.length > attention.length && (
          <button className="link" onClick={() => setShowAll(!showAll)}>
            {showAll ? 'Show only bonds to review' : `Show all ${rows.length}`}
          </button>
        )}
      </div>
      {shown.length ? (
        <div className="stack">
          {shown.map((r) => (
            <RowCard key={r.key} r={r} onPatch={(p) => patch(r.key, p)} onRemove={() => remove(r.key)} onDetails={() => setFixKey(r.key)} />
          ))}
        </div>
      ) : (
        <div className="callout small">All bonds matched exchange data.</div>
      )}

      <div className="flow-foot">
        {check.notices.map((n) => (
          <div key={n.kind} className="warnb">
            {n.message}
          </div>
        ))}
        {skipped > 0 && <div className="infob">Skipped {skipped === 1 ? '1 holding that is' : `${skipped} holdings that are`} shares or mutual funds.</div>}
        {fileProblems.map((f) => (
          <div key={f.file.name} className="errb stack-sm">
            <span>
              <b>{f.file.name}:</b> {f.message}
            </span>
            {(f.status === 'password_required' || f.status === 'password_incorrect') && (
              <div className="row" style={{ gap: 8 }}>
                <input className="input" type="password" autoComplete="off" placeholder="PDF password (not stored)" aria-label={`Password for ${f.file.name}`} value={f.password} onChange={(e) => setFiles(files.map((x) => (x.file.name === f.file.name ? { ...x, password: e.target.value } : x)))} />
                <button className="btn btn-primary btn-sm" disabled={!f.password || working} onClick={() => onUnlock(f)}>
                  Unlock
                </button>
              </div>
            )}
            {f.status === 'unreadable' && (
              <button className="link" style={{ alignSelf: 'flex-start' }} disabled={working} onClick={() => onUnlock(f)}>
                Retry
              </button>
            )}
          </div>
        ))}
        {blocked.length > 0 && <div className="errb">Fix the highlighted {blocked.length === 1 ? 'bond' : `${blocked.length} bonds`} or remove {blocked.length === 1 ? 'it' : 'them'}.</div>}
        {needsOwner && (
          <OwnerBlock own={own} owner={ownerKind} setOwner={setOwner} label={ownerLabel} setLabel={setOwnerLabel} onRemoveFile={onRemoveFile} busy={working} />
        )}
        {(error || err) && <div className="errb">{error || err}</div>}
        {!consented && (
          <label className="agree">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            <span>
              I agree to the{' '}
              <a href={TERMS_URL} target="_blank" rel="noreferrer">
                Terms
              </a>{' '}
              and{' '}
              <a href={PRIVACY_URL} target="_blank" rel="noreferrer">
                Privacy Policy
              </a>
              , and allow BondScanner to store these holdings to show payouts and send reminders.{' '}
              <button type="button" className="link" onClick={(e) => (e.preventDefault(), setTerms(true))}>
                Data we store
              </button>
            </span>
          </label>
        )}
        <button className="btn btn-primary btn-block" disabled={!check.committable || !ownerOk || !agreed || busy || working} onClick={() => (check.match ? setMatch(check.match) : commit({ mode: 'new' }))}>
          {working ? 'Reading…' : 'Confirm'}
        </button>
      </div>

      {fixRow && (
        <InvestmentSheet
          isin={fixRow.isin ?? ''}
          initial={{ units: fixRow.units, acquiredOn: fixRow.acquiredOn, investedAmount: fixRow.investedAmount, purchaseYield: fixRow.purchaseYield }}
          today={today}
          intro="Bond terms are fetched from the ISIN. Add your investment details."
          onClose={() => setFixKey(null)}
          onSave={(v) => {
            patch(fixRow.key, { units: v.units, acquiredOn: v.acquiredOn, investedAmount: v.investedAmount, purchaseYield: v.purchaseYield, ok: true });
            setFixKey(null);
          }}
        />
      )}
      {terms && <KeepSheet onClose={() => setTerms(false)} />}
      {match && <DuplicateSheet match={match} rows={rows} statementDate={statementDate} onClose={() => setMatch(null)} onKeep={onKeep} onCommit={(b) => commit(b)} busy={busy} />}
    </div>
  );
}

function RowCard({ r, onPatch, onRemove, onDetails }: { r: ReviewRow; onPatch: (p: Partial<ReviewRow>) => void; onRemove: () => void; onDetails: () => void }) {
  const [isin, setIsin] = useState('');
  const [isinErr, setIsinErr] = useState(false);
  const bad = BLOCKING.includes(r.status);
  const BADGE: Record<string, [string, string]> = {
    bad_isin: ['b-error', 'Check ISIN'],
    needs_units: ['b-error', 'Needs units'],
    not_found: ['b-error', 'Not in our records'],
    awaiting: ['b-info', 'Details awaited'],
    check: ['b-warning', 'Check'],
    your_details: ['b-info', 'Your details'],
    ready: ['b-success', 'Matched'],
  };
  const [cls, label] = BADGE[r.status];
  const title = r.bond?.name ?? r.customTerms?.name ?? (r.status === 'bad_isin' ? r.nameHint || 'ISIN not readable' : r.nameHint || 'Bond not in our records');
  const already = r.alreadyIn ?? [];
  const warn = r.status === 'check' || already.length > 0;
  return (
    <div className={`rv ${bad ? 'bad' : warn ? 'warn' : ''}`}>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <b style={{ fontWeight: 600, color: 'var(--text-title)', minWidth: 0 }}>{title}</b>
        <span className={`badge ${cls}`}>{label}</span>
      </div>
      <div className="meta">
        {r.isin ?? 'No ISIN'}
        {r.bond && ` · ${r.bond.rating ?? 'NR'} · ${r.bond.couponRate}% · ${FREQUENCY_LABEL[r.bond.frequency]} · matures ${formatDateNumeric(r.bond.maturityDate)}`}
        {!r.bond && r.customTerms && ` · ${r.customTerms.couponRate}% · ${FREQUENCY_LABEL[r.customTerms.frequency]} · face value ₹${r.customTerms.faceValue} · matures ${formatDateNumeric(r.customTerms.maturityDate)}`}
        {r.files && r.files.length > 1 && ` · in ${r.files.length} files, units added`}
        {r.investedAmount ? ` · invested ${inr(r.investedAmount)}` : ''}
        {r.acquiredOn ? ` on ${formatDateNumeric(r.acquiredOn)}` : ''}
        {r.purchaseYield != null ? ` · ${r.purchaseYield}% yield` : ''}
      </div>
      {r.note && <span className="small" style={{ color: bad ? 'var(--error)' : 'var(--text-muted)' }}>{r.note}</span>}
      {already.length > 0 && (
        <div className="warnb">
          Already in {already.map((a) => `${a.name} (${a.units} units)`).join(', ')}.{' '}
          <button className="link danger" onClick={onRemove}>
            Don’t add again
          </button>
        </div>
      )}
      {r.status === 'bad_isin' && (
        <div className="stack-sm">
          <div className="row" style={{ gap: 8 }}>
            <input className={`input ${isinErr ? 'err' : ''}`} placeholder="Type the 12-character ISIN" aria-label="Correct ISIN" value={isin} onChange={(e) => (setIsin(e.target.value), setIsinErr(false))} />
            <button
              className="btn btn-soft btn-sm"
              onClick={() => {
                const v = normaliseIsin(isin);
                if (isValidIsin(v)) onPatch({ isin: v });
                else setIsinErr(true);
              }}
            >
              Fix
            </button>
          </div>
          {isinErr && <span className="hint err">Invalid ISIN. An Indian ISIN has 12 characters and starts with IN.</span>}
          {!!r.suggestions?.length && (
            <div className="wrap">
              <span className="small subtle">Did you mean</span>
              {r.suggestions.map((sg) => (
                <button key={sg.isin} className="chip sm" onClick={() => onPatch({ isin: sg.isin })}>
                  {sg.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="row">
        {r.status !== 'awaiting' ? <Stepper value={r.units} label="Units" onChange={(n) => onPatch({ units: n, ok: true })} /> : <span className="small subtle">{r.units} units</span>}
        <span className="row" style={{ gap: 14, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {r.suggestedUnits && (
            <button className="link" onClick={() => onPatch({ units: r.suggestedUnits, ok: true })}>
              Use {r.suggestedUnits} units
            </button>
          )}
          {r.status === 'check' && (
            <button className="link" onClick={() => onPatch({ ok: true })}>
              Looks right
            </button>
          )}
          {r.isin && r.status !== 'bad_isin' && (
            <button className="link" onClick={onDetails}>
              {r.investedAmount ? 'Edit details' : 'Add details (optional)'}
            </button>
          )}
          <button className="link danger" onClick={onRemove}>
            Remove
          </button>
        </span>
      </div>
    </div>
  );
}

/** "Add details": the same fields as Add manually (ISIN shown, then date, units, amount, yield). */
export function InvestmentSheet({ isin, initial, today, onClose, onSave, intro, title = 'Add details' }: { isin: string; initial: Partial<Investment>; today: string; onClose: () => void; onSave: (v: Investment) => void | Promise<void>; intro?: string; title?: string }) {
  const [on, setOn] = useState(initial.acquiredOn ?? '');
  const [units, setUnits] = useState(initial.units ? String(initial.units) : '');
  const [amount, setAmount] = useState(initial.investedAmount ? String(initial.investedAmount) : '');
  const [yld, setYld] = useState(initial.purchaseYield != null ? String(initial.purchaseYield) : '');
  const [issuer, setIssuer] = useState(initial.issuerName ?? '');
  const [show, setShow] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nU = Number(units), nA = Number(amount), nY = Number(yld);
  const bad = { on: !on || on > today, units: !(Number.isInteger(nU) && nU > 0), amount: !(nA > 0), yld: !(yld !== '' && nY >= 0 && nY <= 50) };
  const cls = (b: boolean) => `input ${show && b ? 'err' : ''}`;
  const num = (set: (v: string) => void, d: number) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value.replace(/,/g, '').replace(/[^\d.]/g, '');
    if (new RegExp(`^\\d{0,10}(\\.\\d{0,${d}})?$`).test(v)) set(v);
  };
  // Shown in red under each field after Save.
  const MSG = { on: 'Please enter a valid date of investment', units: 'Units must be a whole number greater than 0', amount: 'Investment amount must be greater than ₹0', yld: 'Yield must be between 0% and 50%' };
  const fieldErr = (k: keyof typeof bad) =>
    show && bad[k] ? (
      <span className="field-err" role="alert">
        {MSG[k]}
      </span>
    ) : null;
  const save = async () => {
    setShow(true);
    setErr(null);
    if (bad.on || bad.units || bad.amount || bad.yld) return;
    try {
      await onSave({ acquiredOn: on, units: nU, investedAmount: nA, purchaseYield: nY, issuerName: issuer.trim() || undefined });
    } catch (x) {
      setErr((x as Error).message);
    }
  };
  return (
    <Sheet onClose={onClose} label={title}>
      <h3 className="h-card">{title}</h3>
      {intro && <p className="p small muted">{intro}</p>}
      <div className="field">
        <label>ISIN</label>
        <input className="input ro" value={isin} readOnly aria-readonly="true" tabIndex={-1} />
      </div>
      <div className="field">
        <label htmlFor="siss">Issuer name</label>
        <input id="siss" className="input" placeholder="E.g. UGRO Capital Limited" maxLength={ISSUER_NAME_MAX} value={issuer} onChange={(e) => setIssuer(e.target.value)} />
      </div>
      <div className="grid2">
        <div className="field">
          <label htmlFor="sdate">Date of investment</label>
          <input id="sdate" type="date" className={cls(bad.on)} max={today} value={on} onChange={(e) => setOn(e.target.value)} />
          {fieldErr('on')}
        </div>
        <div className="field">
          <label htmlFor="su">Units</label>
          <input id="su" className={cls(bad.units)} inputMode="numeric" placeholder="E.g. 5" value={units} onChange={(e) => setUnits(e.target.value.replace(/[^\d]/g, ''))} />
          {fieldErr('units')}
        </div>
      </div>
      <div className="grid2">
        <div className="field">
          <label htmlFor="samt">Investment amount (₹)</label>
          <input id="samt" className={cls(bad.amount)} inputMode="decimal" placeholder="E.g. 50,250" value={amount} onChange={num(setAmount, 2)} />
          {fieldErr('amount')}
        </div>
        <div className="field">
          <label htmlFor="syld">Yield (% p.a.)</label>
          <input id="syld" className={cls(bad.yld)} inputMode="decimal" placeholder="E.g. 10.25" value={yld} onChange={num(setYld, 3)} />
          {fieldErr('yld')}
        </div>
      </div>
      {err && (
        <span className="field-err" role="alert">
          {err}
        </span>
      )}
      <div className="modal-actions">
        <button className="btn btn-outline" onClick={onClose} data-track="edit_cancel">
          Cancel
        </button>
        <button className="btn btn-primary" onClick={save} data-track="edit_save">
          Save details
        </button>
      </div>
    </Sheet>
  );
}

/** "Add details" for a bond we don't have yet: same fields as Add manually, missing ones highlighted. */
export function DetailsSheet({ row, today, onClose, onSave, intro }: { row: Pick<ReviewRow, 'isin' | 'units' | 'customTerms' | 'nameHint'>; today: string; onClose: () => void; onSave: (t: CustomTerms) => void | Promise<void>; intro?: string }) {
  const [t, setT] = useState<Partial<CustomTerms>>(row.customTerms ?? { name: row.nameHint });
  const [err, setErr] = useState<string | null>(null);
  return (
    <Sheet onClose={onClose} label="Add bond details">
      <h3 className="h-card">Add bond details</h3>
      <p className="p small muted">
        {row.isin} · {row.units ?? '–'} units. {intro ?? 'This bond is not yet in our records. Enter the highlighted fields from your statement or term sheet. They will be verified once exchange data is available.'}
      </p>
      <div className="field">
        <label>Bond name (optional)</label>
        <input className="input" value={t.name ?? ''} onChange={(e) => setT({ ...t, name: e.target.value })} placeholder="Eg. Xylo Finance NCD" />
      </div>
      <TermsFields t={t} set={(p) => setT({ ...t, ...p })} show />
      {err && <div className="errb">{err}</div>}
      <button
        className="btn btn-primary btn-block"
        onClick={async () => {
          const e = validateCustomTerms(t, today);
          if (e) return setErr(e);
          try {
            await onSave(t as CustomTerms);
          } catch (x) {
            setErr((x as Error).message);
          }
        }}
      >
        Save details
      </button>
      <button className="btn btn-ghost btn-block" onClick={onClose}>
        Cancel
      </button>
    </Sheet>
  );
}

function DuplicateSheet({ match, rows, statementDate, onClose, onKeep, onCommit, busy }: { match: MatchInfo; rows: ReviewRow[]; statementDate: string | null; onClose: () => void; onKeep: () => void; onCommit: (b: Omit<CommitBody, 'rows'>) => void; busy: boolean }) {
  const [sold, setSold] = useState<Set<string>>(new Set());
  const nm = (i: string) => match.names?.[i] ?? rows.find((r) => r.isin === i)?.bond?.name ?? i;
  const d = match.diff;
  const same = match.type === 'same';
  return (
    <Sheet onClose={onClose} label="Matches a saved holding">
      <h3 className="h-card">{same ? 'Already added' : `This looks like “${match.portfolioName}”`}</h3>
      <p className="p small muted">
        {same ? `Same bonds and units as ${match.portfolioName}. No changes found.` : `${match.shared} of these bonds are already in ${match.portfolioName}. Is this a newer statement for the same account?`}
      </p>
      {match.olderThanSaved && (
        <div className="warnb">
          This statement ({statementDate && formatDateNumeric(statementDate)}) is older than the one saved ({match.savedStatementDate && formatDateNumeric(match.savedStatementDate)}). Updating may replace newer figures with older ones.
        </div>
      )}
      {!same && (
        <div className="stack-sm">
          {d.changed.map((c) => (
            <div className="diff" key={c.isin}>
              <span className="badge b-warning">Changed</span>
              <span>
                {nm(c.isin)}: {c.from} → {c.to} units
              </span>
            </div>
          ))}
          {d.added.map((i) => (
            <div className="diff" key={i}>
              <span className="badge b-success">New</span>
              <span>{nm(i)}</span>
            </div>
          ))}
          {d.removed.map((i) => (
            <div className="diff col" key={i}>
              <span className="row" style={{ justifyContent: 'flex-start' }}>
                <span className="badge b-neutral">Missing</span>
                <span>{nm(i)} is not in this statement</span>
              </span>
              <div className="seg mini" role="group" aria-label={`What happened to ${nm(i)}`}>
                <button aria-pressed={!sold.has(i)} onClick={() => setSold((s) => (s.delete(i), new Set(s)))}>
                  Still held
                </button>
                <button aria-pressed={sold.has(i)} onClick={() => setSold((s) => new Set(s.add(i)))}>
                  Sold
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {same ? (
        <>
          <button className="btn btn-primary btn-block" onClick={onKeep}>
            Keep current holding
          </button>
          <button className="btn btn-ghost btn-block" disabled={busy} onClick={() => onCommit({ mode: 'new' })}>
            Add as a separate holding
          </button>
        </>
      ) : (
        <>
          <button className="btn btn-primary btn-block" disabled={busy} onClick={() => onCommit({ mode: 'replace', portfolioId: match.portfolioId, soldIsins: [...sold] })}>
            Update “{match.portfolioName}”
          </button>
          {d.added.length > 0 && (
            <button className="btn btn-soft btn-block" disabled={busy} onClick={() => onCommit({ mode: 'add_new_only', portfolioId: match.portfolioId })}>
              Add only the {d.added.length} new {d.added.length === 1 ? 'bond' : 'bonds'}
            </button>
          )}
          <button className="btn btn-ghost btn-block" disabled={busy} onClick={() => onCommit({ mode: 'new' })}>
            Add as a separate holding
          </button>
          <p className="note" style={{ textAlign: 'center' }}>Bonds common to both holdings will be counted twice.</p>
        </>
      )}
      <button className="link" style={{ alignSelf: 'center' }} onClick={onClose}>
        Cancel
      </button>
    </Sheet>
  );
}

function Wow({ r, onDone }: { r: CommitResult; onDone: () => void }) {
  const total = r.summary.expectedInterest + r.summary.expectedPrincipal;
  const v = useCountUp(total, 1400);
  const nx = r.summary.nextPayout;
  // Shown for about 2.5 seconds, then on to the holdings.
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    const t = window.setTimeout(() => done.current(), 2600);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <div className="flow" onClick={onDone} role="button" aria-label="Continue to your holdings">
      <div className="success" style={{ paddingTop: 48 }}>
        <span className="seal">
          <Icon name="check-line" size={36} />
        </span>
        <h2 className="h-section" style={{ marginTop: 8 }}>
          Added to External holdings
        </h2>
        <div className="earn">
          <div className="in">
            <span className="overline">
              {r.holdingsCount} {r.holdingsCount === 1 ? 'bond' : 'bonds'} · total expected amount
            </span>
            <span className="big" aria-label={inr(Math.round(total))}>
              {inr(Math.round(v))}
            </span>
            <span className="small muted">principal plus interest, before tax</span>
          </div>
          <div className="foot">
            {nx ? (
              <>
                Next payout: <b>{inr(Math.round(nx.amount))}</b> on <b>{formatDate(nx.date)}</b>
              </>
            ) : (
              'Payouts added to your payout calendar'
            )}
          </div>
        </div>
        {r.awaitingCount > 0 && <p className="p small muted">{r.awaitingCount === 1 ? '1 bond is' : `${r.awaitingCount} bonds are`} awaiting details. They will be fetched automatically and your holdings updated.</p>}
      </div>
    </div>
  );
}
