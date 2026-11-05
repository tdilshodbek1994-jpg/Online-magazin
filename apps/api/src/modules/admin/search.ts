import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { can, requireUser } from '../../platform/auth.js';
import { many } from '../../platform/db.js';
import { forbidden } from '../../platform/errors.js';
import { type Deps, route } from '../../platform/http.js';

/**
 * Role-scoped global search. Each object type is searched ONLY when the caller holds the permission for it (filter
 * before querying, not hiding afterwards). Phone search needs at least 4 digits and returns masked numbers; tokens,
 * codes and passwords are never searchable.
 */
const mask = (p: string | null) => (p ? `${p.slice(0, 4)} ** *** ${p.slice(-4, -2)} ${p.slice(-2)}` : null);

export function registerSearch(app: FastifyInstance, deps: Deps): void {
  route(app, deps, { method: 'GET', url: '/admin/search', tags: ['admin'], summary: 'Global search across permitted objects', query: z.object({ q: z.string().trim().min(2).max(60) }) },
    async ({ actor, db, query }) => {
      requireUser(actor);
      const q = query.q;
      const like = `%${q.toLowerCase()}%`;
      const digits = q.replace(/\D/g, '');
      const out: { type: string; title: string; subtitle: string; href: string }[] = [];
      let any = false;
      if (can(actor, 'orders.read_all')) {
        any = true;
        const rows = await many<{ id: string; number: string; customer_phone: string | null; payable_minor: string; status: string; name: string | null }>(db, `
          SELECT o.id, o.number, o.customer_phone, o.payable_minor::text, o.commercial_status AS status, o.contact_snapshot->>'name' AS name FROM orders o
           WHERE lower(o.number) LIKE $1 ${digits.length >= 4 ? `OR replace(o.customer_phone, '+', '') LIKE $2` : ''}
           ORDER BY o.created_at DESC LIMIT 8`, digits.length >= 4 ? [like, `%${digits}%`] : [like]);
        for (const r of rows) out.push({ type: 'order', title: `${r.number}${r.name ? ` · ${r.name}` : ''}`, subtitle: `${mask(r.customer_phone) ?? ''} · ${r.status}`, href: `/ops?order=${r.id}` });
      }
      if (can(actor, 'catalog.write') || can(actor, 'inventory.write') || can(actor, 'reports.read')) {
        any = true;
        const rows = await many<{ id: string; sku_code: string; name: Record<string, string>; status: string }>(db, `
          SELECT p.id, s.sku_code, p.name, p.status FROM skus s JOIN products p ON p.id=s.product_id
           WHERE lower(s.sku_code) LIKE $1 OR lower(COALESCE(s.barcode,'')) LIKE $1 OR p.search_doc LIKE $1 ORDER BY p.updated_at DESC LIMIT 8`, [like]);
        for (const r of rows) out.push({ type: 'product', title: r.name?.['uz-Latn'] ?? r.sku_code, subtitle: `${r.sku_code} · ${r.status}`, href: `/admin?tab=products&q=${encodeURIComponent(r.sku_code)}` });
      }
      if (can(actor, 'partners.manage') || can(actor, 'payouts.prepare')) {
        any = true;
        const rows = await many<{ id: string; code: string; display_name: string; status: string }>(db, `SELECT id, code, display_name, status FROM partners WHERE lower(code) LIKE $1 OR lower(display_name) LIKE $1 ORDER BY display_name LIMIT 8`, [like]);
        for (const r of rows) out.push({ type: 'partner', title: r.display_name, subtitle: `${r.code} · ${r.status}`, href: `/admin/partner/${r.id}` });
      }
      if (can(actor, 'staff.manage')) {
        const rows = await many<{ id: string; display_name: string | null; phone_e164: string }>(db, `SELECT DISTINCT u.id, u.display_name, u.phone_e164 FROM users u JOIN memberships m ON m.user_id=u.id AND m.revoked_at IS NULL AND m.role_code NOT IN ('customer','partner')
            WHERE lower(COALESCE(u.display_name,'')) LIKE $1 ${digits.length >= 4 ? `OR replace(u.phone_e164,'+','') LIKE $2` : ''} LIMIT 5`, digits.length >= 4 ? [like, `%${digits}%`] : [like]);
        for (const r of rows) out.push({ type: 'staff', title: r.display_name ?? '—', subtitle: mask(r.phone_e164) ?? '', href: `/admin/staff/${r.id}` });
      }
      if (!any) throw forbidden();
      return { q, items: out };
    });
}
