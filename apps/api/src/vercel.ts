import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp } from './server';

/**
 * Vercel function entry: the same Fastify app, created once per warm instance and handed each request.
 * Needs DATABASE_URL (hosted Postgres); migrations run on the first request of each instance (idempotent).
 */
let ready: ReturnType<typeof start> | null = null;
async function start() {
  const app = await buildApp();
  await app.ready();
  return app;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  ready ??= start().catch((e) => {
    ready = null; // let the next request try again (e.g. database briefly unavailable)
    throw e;
  });
  const app = await ready;
  app.server.emit('request', req, res);
}
