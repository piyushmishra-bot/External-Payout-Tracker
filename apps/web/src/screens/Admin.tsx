import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { formatDateNumeric, inr, pct, todayIST, type TemplateProblem, type TemplateRow } from '@eh/core';
import { Confirm, Icon, Sheet } from '../ui';
import { UploadButton } from '../upload';
import { downloadTemplateXlsx, readTemplateFile } from '../templateFile';

/**
 * Admin page (/bond-portfolio/admin): how the feature is being adopted. Data comes from
 * GET /admin/stats, protected by the admin key (EH_ADMIN_TOKEN). The key is kept only for this browser tab.
 */
const API = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/v1/external-holdings';
const KEY = 'eh-admin-key';

type Stats = {
  days: number;
  totals: { signed_up: number; visitors: number; active_7d: number; with_holdings: number; isins: number; rows: number; invested: number };
  funnel: { label: string; users: number }[];
  daily: { day: string; active: number; sign_ups: number; saves: number }[];
  users: { id: string; name: string | null; email: string | null; signed_up: string; last_seen: string; isins: number; invested: number; uploads: number; visits: number }[];
  recent: { at: string; id: string; name: string | null; email: string; event: string; props: Record<string, unknown> }[];
  clicks: { target: string; clicks: number; people: number }[];
};

const EVENT_LABEL: Record<string, string> = {
  eh_signed_up: 'Signed up',
  eh_profile_updated: 'Updated name or email',
  eh_visit: 'Visited',
  eh_add_opened: 'Opened the upload page',
  eh_template_downloaded: 'Downloaded the template',
  eh_template_uploaded: 'Uploaded a file',
  eh_import_parsed: 'Uploaded a statement',
  eh_consent_given: 'Accepted the terms',
  eh_portfolio_append: 'Saved holdings',
  eh_portfolio_new: 'Saved holdings',
  eh_portfolio_replace: 'Saved holdings',
  eh_portfolio_add_new_only: 'Saved holdings',
  eh_portfolio_deleted: 'Deleted a holding',
  eh_holding_removed: 'Removed a bond',
  eh_investment_details_added: 'Edited a bond',
  eh_details_added: 'Added bond details',
  eh_assisted_sent: 'Sent a file for us to add',
  eh_assisted_done: 'File added by our team',
};
/** Button ids (data-track) in words, for the clicks table and activity. */
const BUTTON: Record<string, string> = {
  add_holdings_table: '+ Add holdings (above the table)',
  m_add_holdings: '⊕ Add holdings (phone)',
  m_edit: '✎ Edit (phone)',
  m_edit_done: 'Done editing (phone)',
  m_toggle_metric: 'Switch Amount / Yield / Date (phone)',
  edit_holdings: 'Edit (above the table)',
  edit_done: 'Done editing',
  row_edit: 'Edit a bond (pencil)',
  row_remove: 'Remove a bond (×)',
  remove_bond_confirm: 'Yes, remove',
  remove_bond_cancel: 'Cancel remove',
  edit_save: 'Save details',
  edit_cancel: 'Cancel edit',
  add_popup_manual: 'Pop-up: Add manually',
  add_popup_upload: 'Pop-up: Upload a file',
  manual_add_bond: 'Add bond (manual)',
  manual_cancel: 'Cancel (manual)',
  manual_replace: 'Replace (manual)',
  manual_keep_both: 'Keep both (manual)',
  manual_new_holding: 'Add as new holding (manual)',
  update_card_upload: 'Upload external holdings (right card)',
  mobile_add_link: 'Add holdings › (phone)',
  get_started_add: 'Add holdings (Get started)',
  choose_file: 'Choose file',
  help_send_file: 'Send a file (another format)',
  help_send: 'Send to BondScanner',
  save_bonds: 'Save bonds (upload)',
  upload_replace: 'Replace (upload)',
  upload_new_holding: 'Add as new holding (upload)',
  upload_keep_both: 'Keep both (upload)',
  tnc_checkbox: 'Terms checkbox',
  banner_close: 'Close 24-hour banner',
  popup_close: 'Close a pop-up (×)',
  back: 'Back arrow',
};
const buttonLabel = (t: string) => BUTTON[t] ?? (/^faq_\d+$/.test(t) ? `FAQ question ${t.slice(4)}` : t.replace(/_/g, ' '));
const eventLabel = (e: string, p: Record<string, unknown>) => {
  if (e === 'eh_click') return `Clicked: ${buttonLabel(String(p?.target ?? ''))}`;
  const base = EVENT_LABEL[e] ?? e.replace(/^eh_/, '').replace(/_/g, ' ');
  const extra = p?.format ? ` (${String(p.format).toUpperCase()})` : typeof p?.rows === 'number' ? ` · ${p.rows} row${p.rows === 1 ? '' : 's'}` : '';
  return base + extra;
};
/** "2026-11-24T14:05" (IST) → "24/11/2026, 14:05" */
const when = (s: string) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}, ${s.slice(11, 16)}` : '–');
const dd = (s: string) => `${s.slice(8, 10)}/${s.slice(5, 7)}`;
const share = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '–');
/** No login: a visitor is shown by name when bondscanner.com passes it, else as "Visitor" + a short id. */
const who = (name: string | null | undefined, id: string) => name || `Visitor ${id.replace(/^preview-/, '').slice(0, 8)}`;

function readKey() {
  try {
    return sessionStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

export function AdminScreen() {
  const [key, setKey] = useState(readKey);
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Stats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!key) return;
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(`${API}/admin/stats?days=${days}`, { headers: { 'x-admin-token': key } });
      const j = await res.json().catch(() => ({}));
      if (res.status === 401 || res.status === 404) {
        setErr('That admin key did not work.');
        setKey('');
        try {
          sessionStorage.removeItem(KEY);
        } catch {
          /* ignore */
        }
        return;
      }
      if (!res.ok) throw new Error(j.message ?? 'Could not load the numbers.');
      setData(j as Stats);
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setLoading(false);
    }
  }, [key, days]);
  useEffect(() => void load(), [load]);

  if (!key) return <KeyForm err={err} onKey={(k) => (setKey(k), (() => { try { sessionStorage.setItem(KEY, k); } catch { /* ignore */ } })())} />;

  const t = data?.totals;
  return (
    <div className="bs-page admin">
      <header className="admin-head">
        <div>
          <h1>Feature adoption</h1>
          <p>External bonds holdings · admin</p>
        </div>
        <div className="admin-tools">
          <label className="year-pill" aria-label="Period">
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </select>
            <Icon name="arrow-down-s-line" size={16} />
          </label>
          <button className="btn btn-outline btn-sm" onClick={load} disabled={loading}>
            <Icon name="refresh-line" size={16} /> {loading ? 'Loading…' : 'Refresh'}
          </button>
          <button
            className="btn btn-outline btn-sm"
            onClick={() => {
              try {
                sessionStorage.removeItem(KEY);
              } catch {
                /* ignore */
              }
              setKey('');
              setData(null);
            }}
          >
            Lock
          </button>
        </div>
      </header>

      {err && <div className="errb">{err}</div>}
      {!data ? (
        <div className="bs-card empty">Loading…</div>
      ) : (
        <>
          <section className="admin-kpis" aria-label="Headline numbers">
            <Kpi label="Visitors" value={String(t!.visitors)} sub="People who opened the tool" />
            <Kpi label="Active in the last 7 days" value={String(t!.active_7d)} sub={`${share(t!.active_7d, t!.visitors)} of visitors`} />
            <Kpi label="Adopted (have holdings)" value={String(t!.with_holdings)} sub={`${share(t!.with_holdings, t!.visitors)} of visitors`} />
            <Kpi label="ISINs tracked" value={String(t!.isins)} sub={`${t!.rows} rows in all holdings`} />
            <Kpi label="Amount tracked" value={inr(t!.invested)} sub="Total investment across users" />
          </section>

          <div className="admin-grid">
            <section className="bs-card admin-card" aria-labelledby="fun-h">
              <h2 id="fun-h" className="h-card">Adoption funnel</h2>
              <p className="admin-note">People who reached each step at least once, out of everyone who visited.</p>
              <Funnel steps={data.funnel} />
            </section>
            <section className="bs-card admin-card" aria-labelledby="day-h">
              <h2 id="day-h" className="h-card">Active people per day</h2>
              <p className="admin-note">Last {data.days} days (IST). Hover a bar for saves.</p>
              <DailyChart rows={data.daily} days={data.days} />
            </section>
          </div>

          <section className="bs-card admin-card" aria-labelledby="cl-h">
            <h2 id="cl-h" className="h-card">Button clicks</h2>
            <p className="admin-note">Every button press in the last {data.days} days: how often, and by how many people.</p>
            <div className="tw">
              <table className="rt admin-rt">
                <thead>
                  <tr>
                    <th>Button</th>
                    <th>Clicks</th>
                    <th>People</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.clicks ?? []).length === 0 && (
                    <tr>
                      <td colSpan={3}>No clicks yet.</td>
                    </tr>
                  )}
                  {(data.clicks ?? []).map((c) => (
                    <tr key={c.target}>
                      <td>{buttonLabel(c.target)}</td>
                      <td>{c.clicks}</td>
                      <td>{c.people}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <AssistedRequests adminKey={key} />

          <section className="bs-card admin-card" aria-labelledby="ppl-h">
            <h2 id="ppl-h" className="h-card">People ({data.users.length})</h2>
            <div className="tw">
              <table className="rt admin-rt">
                <thead>
                  <tr>
                    <th>Visitor</th>
                    <th>Email</th>
                    <th>First seen</th>
                    <th>Last seen</th>
                    <th>ISINs</th>
                    <th>Investment amount</th>
                    <th>Uploads saved</th>
                    <th>Visits</th>
                  </tr>
                </thead>
                <tbody>
                  {data.users.length === 0 && (
                    <tr>
                      <td colSpan={8}>No visitors yet.</td>
                    </tr>
                  )}
                  {data.users.map((u) => (
                    <tr key={u.id}>
                      <td>{who(u.name, u.id)}</td>
                      <td>{u.email || '–'}</td>
                      <td>{when(u.signed_up)}</td>
                      <td>{when(u.last_seen)}</td>
                      <td>{u.isins}</td>
                      <td>{u.invested ? inr(u.invested) : '–'}</td>
                      <td>{u.uploads}</td>
                      <td>{u.visits}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="bs-card admin-card" aria-labelledby="act-h">
            <h2 id="act-h" className="h-card">Recent activity</h2>
            <div className="tw">
              <table className="rt admin-rt">
                <thead>
                  <tr>
                    <th>When (IST)</th>
                    <th>Who</th>
                    <th>What</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent.length === 0 && (
                    <tr>
                      <td colSpan={3}>Nothing yet.</td>
                    </tr>
                  )}
                  {data.recent.map((r, i) => (
                    <tr key={i}>
                      <td>{when(r.at)}</td>
                      <td>
                        {who(r.name, r.id)}
                        {r.email && <span className="isin">{r.email}</span>}
                      </td>
                      <td>{eventLabel(r.event, r.props)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

type Assisted = { id: string; userId: string; name: string | null; email: string | null; fileName: string; mime: string; size: number; note: string | null; status: 'received' | 'done'; createdAt: string; doneAt: string | null; hasFile: boolean; rowsAdded: number | null };

/** Files visitors sent in any format: download, add the holdings, then mark as added (the visitor sees it is done). */
function AssistedRequests({ adminKey }: { adminKey: string }) {
  const [list, setList] = useState<Assisted[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [adding, setAdding] = useState<Assisted | null>(null);
  const [deleting, setDeleting] = useState<Assisted | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API}/admin/assisted`, { headers: { 'x-admin-token': adminKey } });
      if (!r.ok) throw new Error('Could not load the files.');
      setList((await r.json()).requests);
    } catch (x) {
      setErr((x as Error).message);
    }
  }, [adminKey]);
  useEffect(() => void load(), [load]);
  const download = async (a: Assisted) => {
    const r = await fetch(`${API}/admin/assisted/${a.id}/file`, { headers: { 'x-admin-token': adminKey } });
    if (!r.ok) return setErr('Could not download that file.');
    const url = URL.createObjectURL(await r.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = a.fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };
  const mark = async (a: Assisted, done: boolean) => {
    const r = await fetch(`${API}/admin/assisted/${a.id}/done`, { method: 'POST', headers: { 'x-admin-token': adminKey, 'content-type': 'application/json' }, body: JSON.stringify({ done }) });
    if (!r.ok) return setErr('Could not update that request.');
    load();
  };
  const deleteFile = async (a: Assisted) => {
    const r = await fetch(`${API}/admin/assisted/${a.id}/file`, { method: 'DELETE', headers: { 'x-admin-token': adminKey } });
    setDeleting(null);
    if (!r.ok) return setErr('Could not delete that file.');
    setMsg(`Deleted ${a.fileName}. The request stays in the list.`);
    load();
  };
  const open = list?.filter((a) => a.status === 'received').length ?? 0;
  return (
    <section className="bs-card admin-card" aria-labelledby="as-h">
      <h2 id="as-h" className="h-card">
        Files sent by visitors {list ? `(${open} to do)` : ''}
      </h2>
      <p className="admin-note">
        Visitors sent these in any format. Download the file, fill our template with their bonds, then use Add holdings: the bonds go straight into that visitor’s holdings and the request is marked added. Delete the file afterwards to free space.
      </p>
      {err && <div className="errb">{err}</div>}
      {msg && (
        <div className="infob" role="status">
          {msg}
        </div>
      )}
      <div className="tw">
        <table className="rt admin-rt">
          <thead>
            <tr>
              <th>Sent (IST)</th>
              <th>Who</th>
              <th>File</th>
              <th>Note</th>
              <th>Status</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {list && list.length === 0 && (
              <tr>
                <td colSpan={6}>No files yet.</td>
              </tr>
            )}
            {list?.map((a) => (
              <tr key={a.id}>
                <td>{when(a.createdAt)}</td>
                <td>
                  {who(a.name, a.userId)}
                  {a.email && <span className="isin">{a.email}</span>}
                </td>
                <td>
                  {a.hasFile ? (
                    <button className="link-btn" onClick={() => download(a)}>
                      {a.fileName}
                    </button>
                  ) : (
                    <span>{a.fileName}</span>
                  )}
                  <span className="isin">{a.hasFile ? `${Math.max(1, Math.round(a.size / 1024))} KB` : 'File deleted'}</span>
                </td>
                <td style={{ whiteSpace: 'normal', minWidth: 160 }}>{a.note || '–'}</td>
                <td>
                  {a.status === 'done' ? `Added ${when(a.doneAt ?? '')}` : 'To do'}
                  {a.rowsAdded ? <span className="isin">{a.rowsAdded} bond{a.rowsAdded === 1 ? '' : 's'} added</span> : null}
                </td>
                <td>
                  <span className="admin-acts">
                    <button className="btn btn-primary btn-sm" onClick={() => (setErr(null), setMsg(null), setAdding(a))}>
                      Add holdings
                    </button>
                    {a.status === 'done' ? (
                      <button className="btn btn-outline btn-sm" onClick={() => mark(a, false)}>
                        Undo
                      </button>
                    ) : (
                      <button className="btn btn-outline btn-sm" onClick={() => mark(a, true)}>
                        Mark as added
                      </button>
                    )}
                    {a.hasFile && (
                      <button className="btn btn-outline btn-sm btn-danger-text" onClick={() => setDeleting(a)}>
                        Delete file
                      </button>
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {deleting && (
        <Confirm
          title="Delete this file?"
          body={
            <>
              This permanently deletes <b>‘{deleting.fileName}’</b> to free space. The request stays in this list. It cannot be undone.
            </>
          }
          confirm="Yes, delete"
          track="admin_delete_file"
          onClose={() => setDeleting(null)}
          onConfirm={() => deleteFile(deleting)}
        />
      )}
      {adding && (
        <AddForVisitor
          adminKey={adminKey}
          request={adding}
          onClose={() => setAdding(null)}
          onDone={(n, holding) => {
            setAdding(null);
            setMsg(`Added ${n} bond${n === 1 ? '' : 's'} to ${who(adding.name, adding.userId)}’s ${holding}. They see them on their holdings page.`);
            load();
          }}
        />
      )}
    </section>
  );
}

/** Add the visitor's bonds (read from the file they sent) by uploading our filled template. */
function AddForVisitor({ adminKey, request, onClose, onDone }: { adminKey: string; request: Assisted; onClose: () => void; onDone: (n: number, holding: string) => void }) {
  const [parsed, setParsed] = useState<{ name: string; rows: TemplateRow[]; problems: TemplateProblem[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pick = async (files: File[]) => {
    setErr(null);
    try {
      const r = await readTemplateFile(files[0], todayIST());
      setParsed({ name: files[0].name, rows: r.rows, problems: r.problems });
    } catch (x) {
      setErr((x as Error).message);
    }
  };
  const save = async () => {
    if (!parsed?.rows.length) return;
    setBusy(true);
    setErr(null);
    try {
      const rows = parsed.rows.map((r) => ({ isin: r.isin, issuerName: r.issuerName, units: r.units, investedAmount: r.investedAmount, acquiredOn: r.acquiredOn, purchaseYield: r.purchaseYield }));
      const res = await fetch(`${API}/admin/assisted/${request.id}/holdings`, { method: 'POST', headers: { 'x-admin-token': adminKey, 'content-type': 'application/json' }, body: JSON.stringify({ rows }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.message ?? 'Could not add the holdings.');
      onDone(j.added, j.holding);
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet onClose={onClose} label="Add holdings for this visitor">
      <h3 className="h-card">Add holdings for {who(request.name, request.userId)}</h3>
      <p className="admin-note" style={{ margin: 0 }}>
        From “{request.fileName}”. Fill our template with their bonds (ISIN, issuer name, units, investment amount, date of investment, yield) and upload it here.
      </p>
      <div className="admin-acts">
        <button className="btn btn-outline btn-sm" onClick={() => downloadTemplateXlsx()}>
          <Icon name="download-2-line" size={16} /> Excel template
        </button>
        <UploadButton label={parsed ? 'Choose another file' : 'Upload filled template'} className="btn btn-primary btn-sm" icon={false} accept=".xlsx,.xls,.csv,text/csv" multiple={false} onFiles={pick} />
      </div>
      {parsed && parsed.problems.length > 0 && (
        <div className="errb" role="alert">
          <b>{parsed.problems.length} row{parsed.problems.length === 1 ? '' : 's'} skipped:</b>
          <ul className="tpl-problems">
            {parsed.problems.map((p) => (
              <li key={`${p.row}-${p.message}`}>
                {p.row > 0 && `Row ${p.row}${p.isin ? ` (${p.isin})` : ''}: `}
                {p.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {parsed && parsed.rows.length > 0 && (
        <div className="tw">
          <table className="rt admin-rt">
            <thead>
              <tr>
                <th>Issuer</th>
                <th>Units</th>
                <th>Yield</th>
                <th>Date</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {parsed.rows.map((r) => (
                <tr key={`${r.isin}-${r.acquiredOn}`}>
                  <td>
                    {r.issuerName}
                    <span className="isin">{r.isin}</span>
                  </td>
                  <td>{r.units}</td>
                  <td>{pct(r.purchaseYield)}</td>
                  <td>{formatDateNumeric(r.acquiredOn)}</td>
                  <td>{inr(r.investedAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {err && (
        <div className="errb" role="alert">
          {err}
        </div>
      )}
      <div className="modal-actions">
        <button className="btn btn-outline" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={save} disabled={busy || !parsed?.rows.length}>
          {busy ? 'Saving…' : `Add ${parsed?.rows.length ?? 0} bond${parsed?.rows.length === 1 ? '' : 's'}`}
        </button>
      </div>
    </Sheet>
  );
}

function KeyForm({ err, onKey }: { err: string | null; onKey: (k: string) => void }) {
  const [v, setV] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (v.trim()) onKey(v.trim());
  };
  return (
    <div className="flow welcome">
      <header className="ep-hero">
        <h1>Admin</h1>
        <p>Feature adoption for External bonds holdings.</p>
      </header>
      <form className="bs-card stack welcome-card" onSubmit={submit}>
        <div className="field">
          <label htmlFor="adm-key">Admin key</label>
          <input id="adm-key" className="input" type="password" autoComplete="off" value={v} onChange={(e) => setV(e.target.value)} autoFocus />
        </div>
        {err && (
          <div className="errb" role="alert">
            {err}
          </div>
        )}
        <button className="btn btn-primary btn-block">Open</button>
        <p className="tnc-foot">The key is kept only in this browser tab until you close it or press Lock.</p>
      </form>
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="bs-card admin-kpi">
      <span className="bs-label">{label}</span>
      <b>{value}</b>
      <span className="admin-note">{sub}</span>
    </div>
  );
}

/** One horizontal bar per step, scaled to the first step (sign-ups). */
function Funnel({ steps }: { steps: { label: string; users: number }[] }) {
  const top = Math.max(1, steps[0]?.users ?? 0);
  return (
    <ol className="funnel">
      {steps.map((s, i) => {
        const prev = i ? steps[i - 1].users : s.users;
        return (
          <li key={s.label}>
            <div className="funnel-row">
              <span>{s.label}</span>
              <b>
                {s.users} <span className="admin-note">· {share(s.users, steps[0].users)}</span>
              </b>
            </div>
            <div className="funnel-track" aria-hidden="true">
              <div className="funnel-bar" style={{ width: `${Math.max(s.users ? 2 : 0, (s.users / top) * 100)}%` }} />
            </div>
            {i > 0 && prev > 0 && <span className="admin-note">{share(s.users, prev)} of the step before</span>}
          </li>
        );
      })}
    </ol>
  );
}

/** Active people per day (single series), one bar per day with no gaps for empty days; hover shows the day's numbers. */
function DailyChart({ rows, days }: { rows: Stats['daily']; days: number }) {
  const series = useMemo(() => {
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const out: Stats['daily'] = [];
    const ist = new Date(Date.now() + 5.5 * 3600_000);
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(ist.getTime() - i * 86_400_000).toISOString().slice(0, 10);
      out.push(byDay.get(d) ?? { day: d, active: 0, sign_ups: 0, saves: 0 });
    }
    return out;
  }, [rows, days]);
  const [hover, setHover] = useState<number | null>(null);
  const W = 640;
  const H = 200;
  const PAD = { l: 28, r: 8, t: 12, b: 24 };
  const max = Math.max(1, ...series.map((s) => s.active));
  const niceMax = max <= 4 ? max : Math.ceil(max / 4) * 4;
  const bw = (W - PAD.l - PAD.r) / series.length;
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / niceMax);
  const h = hover != null ? series[hover] : null;
  return (
    <div className="daily">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Active people per day, last ${days} days`} onMouseLeave={() => setHover(null)}>
        {[0, niceMax / 2, niceMax].map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} className="grid" />
            <text x={PAD.l - 6} y={y(v) + 4} textAnchor="end" className="ax">
              {Number.isInteger(v) ? v : v.toFixed(1)}
            </text>
          </g>
        ))}
        {series.map((s, i) => {
          const x = PAD.l + i * bw;
          const top = y(s.active);
          const bh = H - PAD.b - top;
          return (
            <g key={s.day} onMouseEnter={() => setHover(i)}>
              <rect x={x} y={PAD.t} width={bw} height={H - PAD.t - PAD.b} fill="transparent" />
              {s.active > 0 && (
                <path
                  className={`bar ${hover === i ? 'on' : ''}`}
                  d={`M${x + 1},${H - PAD.b} V${top + Math.min(4, bh)} q0,-${Math.min(4, bh)} ${Math.min(4, bh)},-${Math.min(4, bh)} H${x + bw - 1 - Math.min(4, bh)} q${Math.min(4, bh)},0 ${Math.min(4, bh)},${Math.min(4, bh)} V${H - PAD.b} Z`}
                />
              )}
            </g>
          );
        })}
        <text x={PAD.l} y={H - 6} className="ax">
          {dd(series[0].day)}
        </text>
        <text x={W - PAD.r} y={H - 6} textAnchor="end" className="ax">
          {dd(series[series.length - 1].day)}
        </text>
      </svg>
      <div className="daily-tip" aria-live="polite">
        {h ? (
          <>
            <b>{`${dd(h.day)}/${h.day.slice(0, 4)}`}</b> · {h.active} active · {h.saves} save{h.saves === 1 ? '' : 's'}
          </>
        ) : (
          <span className="admin-note">Total in period: {series.reduce((a, s) => a + s.saves, 0)} saves</span>
        )}
      </div>
    </div>
  );
}
