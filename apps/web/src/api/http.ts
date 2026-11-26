import { ApiError, type Api, type CommitBody, type DraftRow, type Investment } from './types';
import type { CustomTerms } from '@eh/core';

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/v1/external-holdings';

/**
 * Who is calling. Local dev: VITE_DEV_USER_ID (e.g. demo-1). Shared preview (VITE_PREVIEW_USERS=1, used for
 * the Vercel link): each browser gets its own random test account, kept in localStorage, so visitors' data
 * never mixes. Production: neither is set; the gateway adds the verified user id.
 */
function previewUserId(): string {
  const KEY = 'eh-preview-user';
  try {
    const have = localStorage.getItem(KEY);
    if (have) return have;
    const id = `preview-${crypto.randomUUID().slice(0, 8)}`;
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    return ((previewUserId as any).memo ??= `preview-${Math.random().toString(36).slice(2, 10)}`);
  }
}
const USER_ID: string | undefined =
  (import.meta.env.VITE_DEV_USER_ID as string | undefined) || (import.meta.env.VITE_PREVIEW_USERS === '1' ? previewUserId() : undefined);

/**
 * HTTP client. In production the app's existing auth reaches the gateway, which
 * forwards the verified user id. In local dev, VITE_DEV_USER_ID sets x-user-id.
 */
export class HttpApi implements Api {
  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const h: Record<string, string> = {};
    if (USER_ID) h['x-user-id'] = USER_ID;
    if (body !== undefined && !(body instanceof FormData)) h['Content-Type'] = 'application/json';
    const res = await fetch(BASE + path, { method, credentials: 'include', headers: h, body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new ApiError(res.status, j.error ?? 'error', j.message ?? 'Something went wrong. Please try again.');
    }
    return res.json() as Promise<T>;
  }

  status = () => this.req<{ consented: boolean; externalPortfolios: number }>('GET', '/status');
  consent = async () => void (await this.req('POST', '/consent'));
  profile = async () => (await this.req<{ profile: { name: string; email: string } | null }>('GET', '/profile')).profile;
  setProfile = async (v: { name: string; email: string }) => void (await this.req('POST', '/profile', v));
  sendAssisted = (file: File, note?: string) => {
    const fd = new FormData();
    if (note) fd.append('note', note);
    fd.append('file', file);
    return this.req<{ id: string }>('POST', '/assisted', fd);
  };
  myAssisted = async () => (await this.req<{ requests: any[] }>('GET', '/assisted')).requests;
  trackEvent = (name: 'eh_add_opened' | 'eh_template_downloaded' | 'eh_click', props?: Record<string, string | number>) =>
    void this.req('POST', '/events', { name, props }).catch(() => undefined);
  overview = (scope = 'all') => this.req<any>('GET', `/overview?scope=${encodeURIComponent(scope)}`);
  payouts = (o: { scope?: string; from?: string; to?: string } = {}) =>
    this.req<any>('GET', `/payouts?${new URLSearchParams(Object.entries(o).filter(([, v]) => v) as [string, string][])}`);
  setReceived = async (holdingId: string, scheduledDate: string, received: boolean) =>
    void (await this.req('POST', '/payouts/received', { holdingId, scheduledDate, received }));
  setInvestment = async (holdingId: string, v: Investment) => void (await this.req('PUT', `/holdings/${holdingId}/investment`, v));
  addDetails = async (holdingId: string, customTerms: CustomTerms) => void (await this.req('PUT', `/holdings/${holdingId}/details`, { customTerms }));
  report = (scope = 'all') => this.req<any>('GET', `/report?scope=${encodeURIComponent(scope)}`);
  searchBonds = async (q: string) => (await this.req<{ results: any[] }>('GET', `/bonds/search?q=${encodeURIComponent(q)}`)).results;
  uploadFiles = (files: { file: File; password?: string }[]) => {
    const fd = new FormData();
    files.forEach((f, i) => f.password && fd.append(`password_${i}`, f.password));
    files.forEach((f) => fd.append('file', f.file));
    return this.req<any>('POST', '/imports', fd);
  };
  manual = (rows: { isin: string; units: number; customTerms?: unknown }[]) => this.req<any>('POST', '/imports/manual', { rows });
  pendingImport = async () => (await this.req<{ pending: any }>('GET', '/imports/pending')).pending;
  review = (id: string, rows: DraftRow[], opts: { replacePortfolioId?: string; alsoImportIds?: string[]; removedFiles?: string[] } = {}) =>
    this.req<any>('POST', `/imports/${id}/review`, { rows, ...opts });
  commit = (id: string, body: CommitBody) => this.req<any>('POST', `/imports/${id}/commit`, body);
  discard = async (id: string) => void (await this.req('DELETE', `/imports/${id}`));
  rename = (id: string, name: string) => this.req<{ name: string }>('PATCH', `/portfolios/${id}`, { name });
  deletePortfolio = async (id: string) => void (await this.req('DELETE', `/portfolios/${id}`));
  removeHolding = (id: string) => this.req<{ portfolioDeleted: boolean }>('DELETE', `/holdings/${id}`);
}
