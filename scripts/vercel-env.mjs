// Sets the preview's settings on the linked Vercel project (Production + Preview). Run once:
//   node scripts/vercel-env.mjs
// EH_ADMIN_TOKEN is generated here and stored only in Vercel and in .env.local (gitignored); it is never printed.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const local = existsSync('.env.local') ? readFileSync('.env.local', 'utf8') : '';
const admin = /^EH_ADMIN_TOKEN=(.+)$/m.exec(local)?.[1]?.replace(/^"|"$/g, '') ?? randomBytes(24).toString('base64url');
if (!/^EH_ADMIN_TOKEN=/m.test(local)) appendFileSync('.env.local', `\nEH_ADMIN_TOKEN="${admin}"\n`);

const vars = {
  BOND_PROVIDERS: 'directory', // bondscanner.com sync + uploaded directory; no fixture bonds
  OCR_ENGINE: 'none', // screenshots are not part of the template flow
  PG_POOL_MAX: '3', // serverless: few connections per instance
  EH_ADMIN_TOKEN: admin,
};
for (const [name, value] of Object.entries(vars))
  for (const target of ['production', 'preview']) {
    try {
      execFileSync(npx, ['--yes', 'vercel@latest', 'env', 'rm', name, target, '--yes'], { stdio: 'ignore', shell: true });
    } catch {}
    execFileSync(npx, ['--yes', 'vercel@latest', 'env', 'add', name, target], { input: value, stdio: ['pipe', 'ignore', 'inherit'], shell: true });
    console.log(`set ${name} (${target})`);
  }
