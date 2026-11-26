/**
 * Fills the bond directory from bondscanner.com's live bonds (terms + payout schedule), via the running API.
 *
 *   npm run sync:bondscanner -w apps/api               # read and save
 *   npm run sync:bondscanner -w apps/api -- --dry-run  # read only
 *
 * Env: EH_ADMIN_TOKEN (same as the API's), API_URL (default http://localhost:4010).
 */
const dryRun = process.argv.includes('--dry-run');
const token = process.env.EH_ADMIN_TOKEN;
const api = (process.env.API_URL ?? 'http://localhost:4010').replace(/\/$/, '');
if (!token) {
  console.error('Set EH_ADMIN_TOKEN to the same value the API was started with.');
  process.exit(1);
}
console.log('Reading bondscanner.com live bonds (about 30 seconds)…');
const res = await fetch(`${api}/v1/external-holdings/admin/bond-directory/sync-bondscanner${dryRun ? '?dryRun=1' : ''}`, {
  method: 'POST',
  headers: { 'x-admin-token': token },
});
const body = (await res.json().catch(() => ({}))) as any;
if (!res.ok) {
  console.error(`Sync failed (${res.status}): ${body.message ?? JSON.stringify(body)}`);
  process.exit(1);
}
console.log(`${body.listed} live bonds listed; ${body.valid} read with full terms; ${dryRun ? 'nothing saved (dry run)' : `${body.saved} saved to the directory`}.`);
for (const p of body.problems ?? []) console.log(`  ${p.isin}: ${p.message}`);
