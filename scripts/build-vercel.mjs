// Builds the shareable preview for Vercel in its Build Output API format (.vercel/output):
//   static/          the web page (served at /bond-portfolio, / redirects there)
//   functions/api    the API as one bundled Node function (all /v1/* requests)
// Run: node scripts/build-vercel.mjs   (Vercel runs it as the build command; it also works locally)
import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const out = join(root, '.vercel', 'output');
rmSync(out, { recursive: true, force: true });

// 1. Web page: served from /, each browser gets its own test account (VITE_PREVIEW_USERS=1).
execSync('npm run build -w apps/web', {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, VITE_BASE: '/', VITE_PREVIEW_USERS: '1', VITE_DEV_USER_ID: '' },
});
cpSync(join(root, 'apps/web/dist'), join(out, 'static'), { recursive: true });

// 2. API: one ESM bundle. Optional heavy engines that the preview never uses (screenshot OCR, PDF
//    statements, the embedded dev database) stay out of the bundle; Postgres comes from DATABASE_URL.
const fn = join(out, 'functions', 'api.func');
mkdirSync(fn, { recursive: true });
await build({
  entryPoints: [join(root, 'apps/api/src/vercel.ts')],
  outfile: join(fn, 'index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['pg-native', '@electric-sql/pglite', 'tesseract.js', 'pdfjs-dist', 'pdfjs-dist/*'],
  // CommonJS dependencies inside an ESM bundle need require/__dirname.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; import { fileURLToPath as __fu } from 'node:url'; import { dirname as __dn } from 'node:path'; const require = __cr(import.meta.url); const __filename = __fu(import.meta.url); const __dirname = __dn(__filename);",
  },
  logLevel: 'warning',
});
cpSync(join(root, 'apps/api/migrations'), join(fn, 'migrations'), { recursive: true });
writeFileSync(
  join(fn, '.vc-config.json'),
  JSON.stringify({ runtime: 'nodejs22.x', handler: 'index.mjs', launcherType: 'Nodejs', shouldAddHelpers: false, maxDuration: 60 }, null, 2),
);

// 3. Routes: API, then real files, then the page for every /bond-portfolio/* address.
writeFileSync(
  join(out, 'config.json'),
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: '^/v1/(.*)$', dest: '/api' },
        { handle: 'filesystem' },
        { src: '^/$', status: 307, headers: { Location: '/bond-portfolio' } },
        { src: '^/bond-portfolio(?:/.*)?$', dest: '/index.html' },
      ],
      // Refresh the bond directory from bondscanner.com every day at 06:00 IST (00:30 UTC).
      crons: [{ path: '/v1/external-holdings/cron/sync-bondscanner', schedule: '30 0 * * *' }],
    },
    null,
    2,
  ),
);
console.log(`Vercel output ready in ${out}`);
