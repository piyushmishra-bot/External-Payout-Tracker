import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `npm run build:demo` produces one self-contained HTML file (no backend) for stakeholder review.
// Production is served at bondscanner.com/bond-portfolio (like /payout-detector): assets under that path,
// and the host must return index.html for /bond-portfolio/* so deep links work.
export default defineConfig(({ mode, command }) => ({
  // VITE_BASE overrides it (the Vercel preview serves the files from /).
  base: process.env.VITE_BASE ?? (command === 'build' && mode !== 'demo' ? '/bond-portfolio/' : '/'),
  plugins: [react(), ...(mode === 'demo' ? [viteSingleFile()] : [])],
  server: { port: 5174, proxy: { '/v1': 'http://localhost:4020' } },
  build: { outDir: mode === 'demo' ? 'dist-demo' : 'dist' },
}));
