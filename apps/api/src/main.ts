import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './platform/db.js';
import { startWorker } from './worker.js';

const cfg = loadConfig();
const db = createPool(cfg.databaseUrl, Number(process.env.DB_POOL_MAX ?? 20));
const app = await buildApp(cfg, db);
await app.listen({ port: cfg.port, host: '0.0.0.0' });
// Small servers (DEMO, 2 GB RAM): run the durable worker inside the API process instead of a separate container.
const stopWorker = process.env.RUN_WORKER_IN_API === 'true' ? startWorker(db, cfg, `api-inproc:${process.pid}`) : () => undefined;

const shutdown = async () => {
  stopWorker();
  await app.close();
  await db.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
