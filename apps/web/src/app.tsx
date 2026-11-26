import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Api } from './api/types';
import { DEMO_FILES, type DemoApi } from './api/demo';
import { Icon, Toast } from './ui';
import { ExternalScreen } from './screens/External';
import { TemplateUpload } from './screens/TemplateUpload';
import { BondScreen } from './screens/Bond';
import { PayoutsScreen } from './screens/Payouts';
import { ReportScreen } from './screens/Report';
import { AdminScreen } from './screens/Admin';
import { AddChooser, ManualAdd } from './screens/AddPopups';

export type Route = { name: 'external'; details?: string } | { name: 'add'; to?: string; mode?: 'upload' | 'manual' } | { name: 'bond'; id: string } | { name: 'admin' } | { name: 'payouts'; date?: string } | { name: 'report' };

/**
 * The feature is its own page, like bondscanner.com/payout-detector:
 *   /bond-portfolio                 overview (and ?details=<holdingId> from the "add details" reminder)
 *   /bond-portfolio/add             upload or add manually
 *   /bond-portfolio/bond?id=        one bond
 *   /bond-portfolio/admin           feature adoption (admin key)
 * The single-file demo build keeps #/ URLs because it is opened as a file.
 */
export const BASE = '/bond-portfolio';
const hashMode = () => import.meta.env.MODE === 'demo' || import.meta.env.VITE_DEMO === '1' || location.protocol === 'file:';

/** `sub` is the part after the base, e.g. "add" or "bond"; `qs` the query string. */
function parseRoute(sub: string, qs: string): Route {
  const q = new URLSearchParams(qs);
  switch (sub.replace(/^\/+|\/+$/g, '')) {
    case 'add':
      return { name: 'add', to: q.get('to') ?? undefined, mode: q.get('mode') === 'manual' ? 'manual' : q.get('mode') === 'upload' ? 'upload' : undefined };
    case 'admin':
      return { name: 'admin' };
    case 'payouts':
      return { name: 'payouts', date: q.get('date') ?? undefined };
    case 'report':
      return { name: 'report' };
    case 'bond':
      return q.get('id') ? { name: 'bond', id: q.get('id')! } : { name: 'external' };
    default:
      // '' and the old 'external' / 'holdings' paths all open the overview.
      return { name: 'external', details: q.get('details') ?? undefined };
  }
}

function currentRoute(): Route {
  if (hashMode()) {
    const [p, qs] = location.hash.replace(/^#\/?/, '').split('?');
    return parseRoute(p, qs ?? '');
  }
  return parseRoute(location.pathname.slice(BASE.length), location.search);
}

export function href(r: Route): string {
  const qs = r.name === 'bond' ? `?id=${r.id}` : r.name === 'payouts' && r.date ? `?date=${r.date}` : r.name === 'external' && r.details ? `?details=${r.details}` : r.name === 'add' && (r.to || r.mode) ? `?${new URLSearchParams(Object.entries({ to: r.to, mode: r.mode }).filter(([, v]) => v) as [string, string][])}` : '';
  const sub = r.name === 'external' ? '' : `/${r.name}`;
  return hashMode() ? `#${sub || '/'}${qs}` : `${BASE}${sub}${qs}`;
}

/** Puts the address under /bond-portfolio; old #/ links (e.g. #/external?details=…) keep working. */
function normaliseUrl() {
  if (hashMode()) return;
  if (location.hash.startsWith('#/')) {
    const [p, qs] = location.hash.slice(2).split('?');
    history.replaceState(null, '', href(parseRoute(p, qs ?? '')));
  } else if (location.pathname !== BASE && !location.pathname.startsWith(`${BASE}/`)) {
    history.replaceState(null, '', BASE + location.search);
  }
}

interface Ctx {
  api: Api;
  demo?: DemoApi;
  go: (r: Route) => void;
  toast: (m: string) => void;
  /** "+ Add holdings": pop-up with Add manually / Upload holdings. */
  addHoldings: () => void;
  /** Bumps when data changes so screens refetch. */
  version: number;
  refresh: () => void;
}
const AppCtx = createContext<Ctx>(null as unknown as Ctx);
export const useApp = () => useContext(AppCtx);

/** Small data hook: refetches when `version` or deps change. */
/** Last data per cache key: in memory (going back) and in this tab's sessionStorage (refresh). */
const LOAD_CACHE = new Map<string, unknown>();
function readCache<T>(key?: string): T | null {
  if (!key) return null;
  if (LOAD_CACHE.has(key)) return LOAD_CACHE.get(key) as T;
  try {
    const s = sessionStorage.getItem(`eh-cache:${key}`);
    return s ? (JSON.parse(s) as T) : null;
  } catch {
    return null;
  }
}
function writeCache(key: string | undefined, data: unknown) {
  if (!key) return;
  LOAD_CACHE.set(key, data);
  try {
    sessionStorage.setItem(`eh-cache:${key}`, JSON.stringify(data));
  } catch {
    /* storage full or blocked: memory cache still works */
  }
}

/**
 * Loads data for a screen. With a cacheKey the last result is shown straight away (no loading screen when going
 * back or refreshing) while fresh data loads in the background.
 */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[], cacheKey?: string): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const { version } = useApp();
  const [state, set] = useState<{ data: T | null; error: string | null; loading: boolean }>(() => ({ data: readCache<T>(cacheKey), error: null, loading: true }));
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    set((s) => ({ ...s, loading: true }));
    fn().then(
      (data) => {
        if (!live) return;
        writeCache(cacheKey, data);
        set({ data, error: null, loading: false });
      },
      (e) => live && set((s) => ({ data: s.data, error: e.message ?? 'Something went wrong. Please try again.', loading: false })),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, n, ...deps]);
  return { ...state, reload: () => setN((x) => x + 1) };
}

export function App({ api, demo }: { api: Api; demo?: DemoApi }) {
  const [route, setRoute] = useState<Route>(() => (normaliseUrl(), currentRoute()));
  const [toastMsg, setToast] = useState('');
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const on = () => {
      setRoute(currentRoute());
      window.scrollTo({ top: 0 });
    };
    const ev = hashMode() ? 'hashchange' : 'popstate';
    window.addEventListener(ev, on);
    return () => window.removeEventListener(ev, on);
  }, []);
  useEffect(() => demo?.onChange(() => setVersion((v) => v + 1)), [demo]);

  const go = useCallback((r: Route) => {
    const to = href(r);
    if (hashMode()) {
      if (location.hash === to) setRoute(currentRoute());
      else location.hash = to;
      return;
    }
    if (location.pathname + location.search !== to) history.pushState(null, '', to);
    setRoute(currentRoute());
    window.scrollTo({ top: 0 });
  }, []);
  const toast = useCallback((m: string) => {
    setToast(m);
    window.clearTimeout((toast as any).t);
    (toast as any).t = window.setTimeout(() => setToast(''), 3200);
  }, []);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const [adding, setAdding] = useState<null | 'choose' | 'manual'>(null);
  // Every button with data-track="…" records a click (eh_click) for the admin page.
  useEffect(() => {
    const on = (e: MouseEvent) => {
      const el = (e.target as Element | null)?.closest?.('[data-track]');
      const target = el?.getAttribute('data-track');
      if (target) api.trackEvent('eh_click', { target });
    };
    document.addEventListener('click', on, true);
    return () => document.removeEventListener('click', on, true);
  }, [api]);
  const addHoldings = useCallback(() => setAdding('choose'), []);
  // No login or form: people arrive straight from bondscanner.com (like /payout-detector). This call records the
  // visit for the admin page and, inside bondscanner.com, picks up the logged-in user's name and email from the gateway.
  useEffect(() => {
    api.profile().catch(() => undefined);
  }, [api]);

  let screen: ReactNode;
  if (route.name === 'admin') screen = <AdminScreen />;
  else if (route.name === 'external') screen = <ExternalScreen detailsId={route.details} />;
  else if (route.name === 'add') screen = <TemplateUpload key={route.mode ?? 'choose'} to={route.to} mode={route.mode} />;
  else if (route.name === 'payouts') screen = <PayoutsScreen initialDate={route.date} />;
  else if (route.name === 'report') screen = <ReportScreen />;
  else screen = <BondScreen id={route.id} />;
  const landing = route.name === 'external';

  return (
    <AppCtx.Provider value={{ api, demo, go, toast, version, refresh, addHoldings }}>
      <div className="shell">
        {demo && <DemoBar demo={demo} />}
        {/* No site header here: BondScanner's own navigation bar (logo, search, account) is added by the dev team. */}
        <main className={`page ${landing ? '' : 'sub'}`}>{screen}</main>
        {toastMsg && <Toast message={toastMsg} onClose={() => setToast('')} />}
        {adding === 'choose' && <AddChooser onClose={() => setAdding(null)} onManual={() => setAdding('manual')} onUpload={() => (setAdding(null), go({ name: 'add' }))} />}
        {adding === 'manual' && <ManualAdd onClose={() => setAdding(null)} />}
      </div>
    </AppCtx.Provider>
  );
}

/** Sub-page header as on BondScanner's Payout details: square back button, support, title below. */
export function SubHead({ title, onBack, titleMobileOnly, big }: { title: string; onBack?: () => void; titleMobileOnly?: boolean; big?: boolean }) {
  const { toast } = useApp();
  return (
    <div className={`sub-head ${big ? 'big' : ''}`}>
      <div className="sub-bar">
        {onBack ? (
          <button className="back-btn" onClick={onBack} aria-label="Go back" data-track="back">
            <Icon name="arrow-left-line" size={20} />
          </button>
        ) : (
          <span />
        )}
      </div>
      <h1 className={titleMobileOnly ? 'm-only' : undefined}>{title}</h1>
    </div>
  );
}

/** Floating search pill at the bottom of the Bonds tabs, as on bondscanner.com. */
export function SearchPill({ value, onChange, placeholder = 'Search by Issuer Name or ISIN' }: { value?: string; onChange?: (v: string) => void; placeholder?: string }) {
  return (
    <div className="search-pill">
      <Icon name="search-line" size={20} />
      <input aria-label="Search" placeholder={placeholder} value={value ?? ''} onChange={(e) => onChange?.(e.target.value)} readOnly={!onChange} />
    </div>
  );
}

/** Demo-only controls. The demo files stand in for the phone's file picker. */
function DemoBar({ demo }: { demo: DemoApi }) {
  const [today, setToday] = useState(demo.today);
  const dates: [string, string][] = [
    ['2026-11-17', '17 Nov 2026'],
    ['2026-12-06', '6 Dec (day before a payout)'],
    ['2026-12-11', '11 Dec (payout not marked)'],
    ['2027-12-01', '1 Dec 2027 (a bond matured)'],
  ];
  return (
    <div className="demo-bar" role="region" aria-label="Demo controls">
      <div className="in">
        <b>Demo</b>
        <label>
          Today is{' '}
          <select value={today} onChange={(e) => (setToday(e.target.value), demo.setToday(e.target.value))}>
            {dates.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <span>Demo files:</span>
        {Object.entries(DEMO_FILES).map(([name, s]) => (
          <button
            key={name}
            title={name}
            onClick={() => {
              // Stands in for picking a file in the phone's file picker.
              if (!location.hash.startsWith('#/add')) location.hash = '#/add';
              setTimeout(() => window.dispatchEvent(new CustomEvent('eh-demo-file', { detail: name })), 150);
            }}
          >
            {s.label}
          </button>
        ))}
        <button
          onClick={() => {
            const id = demo.askForDetails();
            if (!id) return alert('Add a bond we don’t have yet first (e.g. type INE0XYZ07016 in Add manually).');
            // Stands in for tapping the push reminder.
            location.hash = `#/external?details=${id}`;
          }}
        >
          Pretend a day passed: details still missing (reminder)
        </button>
        <button onClick={() => demo.releaseAwaiting()}>Pretend our data now has the awaited bond</button>
        <button onClick={() => (demo.seed(), (location.hash = '#/external'))}>Load a sample portfolio</button>
        <button onClick={() => (demo.reset(), (location.hash = '#/'))}>Start over</button>
      </div>
    </div>
  );
}
