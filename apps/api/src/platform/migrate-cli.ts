import { loadConfig } from '../config.js';
import { createPool } from './db.js';
import { migrate, MIGRATIONS_DIR } from './migrate.js';

const cfg = loadConfig();
const db = createPool(cfg.databaseUrl, 2);
migrate(db, MIGRATIONS_DIR, console.log)
  .then((a) => console.log(a.length ? `migrations applied: ${a.length}` : 'schema up to date'))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.end());
