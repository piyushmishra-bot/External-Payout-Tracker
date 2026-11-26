/**
 * Uploads a bond directory (CSV or .xlsx) to a running API.
 *
 *   npm run import:directory -w apps/api -- "C:\path\test_directory.csv"            # check and save
 *   npm run import:directory -w apps/api -- "C:\path\test_directory.csv" --dry-run  # check only
 *
 * Env: EH_ADMIN_TOKEN (must match the API's), API_URL (default http://localhost:4010).
 */
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');
const token = process.env.EH_ADMIN_TOKEN;
const api = (process.env.API_URL ?? 'http://localhost:4010').replace(/\/$/, '');
if (!file) {
  console.error('Usage: npm run import:directory -w apps/api -- <file.csv|file.xlsx> [--dry-run]');
  process.exit(1);
}
if (!token) {
  console.error('Set EH_ADMIN_TOKEN to the same value the API was started with.');
  process.exit(1);
}

// npm runs workspace scripts from apps/api; resolve relative paths from where the command was typed.
const path = resolve(process.env.INIT_CWD ?? process.cwd(), file);
const fd = new FormData();
fd.append('file', new Blob([readFileSync(path)]), basename(path));
const res = await fetch(`${api}/v1/external-holdings/admin/bond-directory${dryRun ? '?dryRun=1' : ''}`, {
  method: 'POST',
  headers: { 'x-admin-token': token },
  body: fd,
});
const body = (await res.json().catch(() => ({}))) as any;
if (!res.ok) {
  console.error(`Upload failed (${res.status}): ${body.message ?? JSON.stringify(body)}`);
  process.exit(1);
}
console.log(`${body.file}: ${body.valid} valid row(s); ${dryRun ? 'nothing saved (dry run)' : `${body.saved} saved`}.`);
for (const p of body.problems ?? []) console.log(`  row ${p.row}${p.isin ? ` (${p.isin})` : ''}: ${p.message}`);
if ((body.problems ?? []).length) process.exitCode = 2;
