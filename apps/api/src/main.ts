import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './platform/db.js';

const cfg = loadConfig();
const db = createPool(cfg.databaseUrl);
const app = await buildApp(cfg, db);
await app.listen({ port: cfg.port, host: '0.0.0.0' });

const shutdown = async () => {
  await app.close();
  await db.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
