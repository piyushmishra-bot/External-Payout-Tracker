import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { config } from './config';
import { buildContainer, type Container } from './container';
import { registerRoutes } from './routes';

export async function buildApp(container?: Container) {
  const c = container ?? (await buildContainer());
  const app = Fastify({
    logger: process.env.NODE_ENV === 'test' ? false : { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization', 'req.headers["x-gateway-secret"]'] },
    bodyLimit: 1024 * 1024,
  });
  await app.register(cors, { origin: config.corsOrigins, credentials: true });
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 5, fields: 12 } });
  await registerRoutes(app, c);
  app.addHook('onClose', async () => c.db.close());
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await buildApp();
  await app.listen({ port: config.port, host: '0.0.0.0' });
}
