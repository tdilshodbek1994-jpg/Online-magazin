import { hostname } from 'node:os';
import { loadConfig } from './config.js';
import { createPool } from './platform/db.js';
import { startWorker } from './worker.js';

const cfg = loadConfig();
const db = createPool(cfg.databaseUrl, 5);
const stop = startWorker(db, cfg, `${hostname()}:${process.pid}`);
const shutdown = async () => {
  stop();
  await new Promise((r) => setTimeout(r, 2500));
  await db.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
