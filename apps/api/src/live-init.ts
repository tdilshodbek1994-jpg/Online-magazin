import { normalizeUzPhone } from '@om/shared';
import { loadConfig } from './config.js';
import { bootstrapReference } from './platform/bootstrap.js';
import { createPool, withTx } from './platform/db.js';
import { migrate, MIGRATIONS_DIR } from './platform/migrate.js';

/**
 * First start of the REAL shop on an empty database (no demo users, products or orders):
 * schema, reference data (owner organization, main warehouse, regions, draft legal texts) and ONE owner account.
 * Run: LIVE_OWNER_PHONE=+998XXXXXXXXX node dist/live-init.js   (idempotent; never touches an existing owner)
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const phone = normalizeUzPhone(process.env.LIVE_OWNER_PHONE ?? '');
  if (!phone) throw new Error('LIVE_OWNER_PHONE (+998XXXXXXXXX) kerak');
  const db = createPool(cfg.databaseUrl, 2);
  try {
    await migrate(db, MIGRATIONS_DIR, () => {});
    await withTx(db, async (tx) => {
      const demo = await tx.query(`SELECT COUNT(*)::int AS n FROM orders`);
      if (demo.rows[0].n > 0 && process.env.LIVE_ALLOW_NONEMPTY !== '1') throw new Error('Bu baza bo‘sh emas (buyurtmalar bor) — live-init faqat yangi baza uchun');
      await bootstrapReference(tx, { shopName: 'UzShop' });
      await tx.query(`UPDATE organizations SET name='UzShop' WHERE kind='platform_owner' AND name LIKE '%DEMO%'`);
      let u = (await tx.query(`SELECT id FROM users WHERE phone_e164=$1 AND status <> 'closed'`, [phone])).rows[0] as { id: string } | undefined;
      if (!u) {
        u = (await tx.query(`INSERT INTO users (phone_e164, phone_verified_at, display_name) VALUES ($1, now(), 'Egasi') RETURNING id`, [phone])).rows[0] as { id: string };
        await tx.query(`INSERT INTO phone_history (user_id, new_phone, method) VALUES ($1,$2,'initial')`, [u.id, phone]);
      }
      for (const r of ['owner', 'customer']) {
        await tx.query(`INSERT INTO memberships (user_id, role_code) SELECT $1,$2 WHERE NOT EXISTS (SELECT 1 FROM memberships WHERE user_id=$1 AND role_code=$2)`, [u.id, r]);
      }
      await tx.query(`INSERT INTO audit_events (actor_kind, action, target_type, target_id, after) VALUES ('system','live.initialized','user',$1,$2)`, [u.id, JSON.stringify({ shop: 'UzShop' })]);
      console.log(`TAYYOR: egasi hisobi ${phone.slice(0, 6)}***${phone.slice(-2)} (kirish SMS kod orqali)`);
    });
  } finally {
    await db.end();
  }
}
main().catch((e) => { console.error('XATO:', (e as Error).message); process.exitCode = 1; });
