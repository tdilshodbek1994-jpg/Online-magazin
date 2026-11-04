import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../platform/audit.js';
import { requirePerm } from '../../platform/auth.js';
import { many, maybeOne, one, withTx } from '../../platform/db.js';
import { notFound } from '../../platform/errors.js';
import { type Deps, route, zIdParam } from '../../platform/http.js';

/**
 * Saved replies (spec §16, §26). Placeholders come only from verified order data: {name} {number} {items} {total}.
 * Anything else ({delivery_date}, …) is NOT guessed — it is returned in `missing` and the composer must fill it.
 */
const T = ['operator-centre'];
const som = (minor: string) => `${(BigInt(minor) / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} so‘m`;

export function renderTemplate(body: string, values: Record<string, string | null | undefined>) {
  const missing: string[] = [];
  const text = body.replace(/\{([a-z_]+)\}/g, (m, k: string) => {
    const v = values[k];
    if (v === undefined || v === null || v === '') { if (!missing.includes(k)) missing.push(k); return m; }
    return v;
  });
  return { text, missing };
}

export function registerReplyTemplates(app: FastifyInstance, deps: Deps): void {
  route(app, deps, { method: 'GET', url: '/ops/center/tasks/:id/templates', tags: T, summary: 'Saved replies rendered with this order’s verified data', params: zIdParam,
    query: z.object({ script: z.enum(['latn', 'cyrl']).default('latn') }) }, async ({ actor, db, params, query }) => {
    requirePerm(actor, 'orders.operate');
    const t = await maybeOne<{ order_id: string }>(db, `SELECT order_id FROM ops_tasks WHERE id=$1`, [params.id]);
    if (!t) throw notFound('TASK');
    const o = await one<any>(db, `SELECT o.number, o.payable_minor::text, o.contact_snapshot->>'name' AS name,
        (SELECT string_agg((ol.product_snapshot->'name'->>'uz-Latn') || ' × ' || (ol.qty - ol.canceled_qty), ', ') FROM order_lines ol WHERE ol.order_id=o.id AND ol.qty > ol.canceled_qty) AS items
      FROM orders o WHERE o.id=$1`, [t.order_id]);
    const values = { name: o.name, number: o.number, items: o.items, total: som(o.payable_minor) };
    const rows = await many<any>(db, `SELECT id, code, version, title, audience, body_latn, body_cyrl FROM reply_templates WHERE status='active' ORDER BY audience, title`);
    return { items: rows.map((r) => { const body = query.script === 'cyrl' && r.body_cyrl ? r.body_cyrl : r.body_latn; return { id: r.id, code: r.code, version: r.version, title: r.title, audience: r.audience, ...renderTemplate(body, values) }; }) };
  });

  route(app, deps, { method: 'GET', url: '/admin/reply-templates', tags: T, summary: 'All saved replies incl. retired versions' }, async ({ actor, db }) => {
    requirePerm(actor, 'orders.reassign');
    return { items: await many(db, `SELECT r.*, u.display_name AS author FROM reply_templates r LEFT JOIN users u ON u.id=r.created_by ORDER BY r.code, r.version DESC`) };
  });

  // Editing creates a NEW version and retires the old one — history is never rewritten.
  route(app, deps, { method: 'POST', url: '/admin/reply-templates', tags: T, summary: 'Create or re-version a saved reply',
    body: z.object({ code: z.string().regex(/^[a-z0-9_]{3,40}$/), title: z.string().min(2).max(120), audience: z.enum(['customer', 'partner']), body_latn: z.string().min(5).max(1000), body_cyrl: z.string().max(1000).optional() }) },
  async ({ actor, db, body }) => {
    requirePerm(actor, 'orders.reassign');
    return withTx(db, async (tx) => {
      const prev = await maybeOne<{ id: string; version: number }>(tx, `SELECT id, version FROM reply_templates WHERE code=$1 ORDER BY version DESC LIMIT 1 FOR UPDATE`, [body.code]);
      if (prev) await tx.query(`UPDATE reply_templates SET status='retired' WHERE code=$1 AND status='active'`, [body.code]);
      const r = await one<{ id: string; version: number }>(tx, `INSERT INTO reply_templates (code, version, title, audience, body_latn, body_cyrl, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, version`,
        [body.code, (prev?.version ?? 0) + 1, body.title, body.audience, body.body_latn, body.body_cyrl ?? null, actor.userId]);
      await audit(tx, actor, 'reply_template.saved', { type: 'reply_template', id: r.id }, { after: { code: body.code, version: r.version } });
      return r;
    });
  });

  route(app, deps, { method: 'POST', url: '/admin/reply-templates/:id/retire', tags: T, summary: 'Retire a saved reply', params: zIdParam }, async ({ actor, db, params }) => {
    requirePerm(actor, 'orders.reassign');
    const r = await db.query(`UPDATE reply_templates SET status='retired' WHERE id=$1 AND status='active' RETURNING code`, [params.id]);
    if (!r.rowCount) throw notFound('TEMPLATE');
    await audit(db, actor, 'reply_template.retired', { type: 'reply_template', id: params.id });
    return { ok: true };
  });
}
