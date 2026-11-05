import { maskPhone, normalizeUzPhone } from '@om/shared';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../platform/audit.js';
import { hashToken, requirePerm, requireStepUp, requireUser } from '../../platform/auth.js';
import { many, maybeOne, one, withTx } from '../../platform/db.js';
import { AppError, badRequest, conflict, notFound } from '../../platform/errors.js';
import { type Deps, route, zIdParam, zLocalized } from '../../platform/http.js';
import { fcmConfigured } from '../notifications/push.js';

/** CSV cell escaping incl. spreadsheet formula injection (T084, AC-M20-2). */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const TZ = 'Asia/Tashkent';

export function registerAdmin(app: FastifyInstance, deps: Deps): void {
  const T = ['admin'];

  // ---------- Staff invitations (§07) ----------
  route(app, deps, { method: 'POST', url: '/admin/staff/invitations', tags: T, summary: 'Invite staff by phone + role', body: z.object({ phone: z.string(), role: z.enum(['owner', 'catalog_manager', 'operator', 'warehouse', 'courier', 'finance']) }) },
    async ({ actor, db, cfg, body }) => {
      requirePerm(actor, 'staff.manage'); requireStepUp(actor);
      const phone = normalizeUzPhone(body.phone);
      if (!phone) throw badRequest('PHONE_INVALID');
      const token = randomBytes(24).toString('base64url');
      const r = await one<{ id: string }>(db, `INSERT INTO staff_invitations (phone_e164, role_code, token_hash, invited_by, expires_at) VALUES ($1,$2,$3,$4, now() + interval '72 hours') RETURNING id`, [phone, body.role, hashToken(token), actor.userId]);
      await audit(db, actor, 'staff.invited', { type: 'staff_invitation', id: r.id }, { after: { phone: maskPhone(phone), role: body.role } });
      // The owner gets the link once and shares it (Telegram etc.). It only works for someone who logs in with THIS phone
      // via SMS code, expires in 72 h and is single-use — the link alone grants nothing.
      return { id: r.id, invite_url: `${cfg.publicWebUrl}/staff/join?token=${token}`, expires_in_hours: 72, ...(cfg.env !== 'production' ? { dev_token: token } : {}) };
    });

  route(app, deps, { method: 'POST', url: '/staff/invitations/accept', tags: T, summary: 'Accept invitation (logged-in user with the invited phone)', body: z.object({ token: z.string().min(20) }) }, async ({ actor, db, body }) => {
    requireUser(actor);
    return withTx(db, async (tx) => {
      const inv = await maybeOne<{ id: string; phone_e164: string; role_code: string; invited_by: string }>(tx, `SELECT * FROM staff_invitations WHERE token_hash=$1 AND accepted_at IS NULL AND expires_at > now() FOR UPDATE`, [hashToken(body.token)]);
      if (!inv) throw new AppError(400, 'INVITATION_INVALID_OR_EXPIRED');
      const u = await one<{ phone_e164: string }>(tx, `SELECT phone_e164 FROM users WHERE id=$1`, [actor.userId]);
      if (u.phone_e164 !== inv.phone_e164) throw new AppError(403, 'INVITATION_PHONE_MISMATCH');
      await tx.query(`INSERT INTO memberships (user_id, role_code, granted_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [actor.userId, inv.role_code, inv.invited_by]);
      await tx.query(`UPDATE staff_invitations SET accepted_at=now(), accepted_user_id=$2 WHERE id=$1`, [inv.id, actor.userId]);
      await audit(tx, actor, 'staff.joined', { type: 'user', id: actor.userId }, { after: { role: inv.role_code } });
      return { ok: true, role: inv.role_code };
    });
  });

  route(app, deps, { method: 'GET', url: '/admin/staff', tags: T, summary: 'Staff and roles' }, async ({ actor, db }) => {
    requirePerm(actor, 'staff.manage');
    return { items: await many(db, `SELECT u.id, u.display_name, u.phone_e164, array_agg(m.role_code ORDER BY m.role_code) AS roles FROM users u JOIN memberships m ON m.user_id=u.id AND m.revoked_at IS NULL WHERE m.role_code NOT IN ('customer','partner') GROUP BY u.id ORDER BY u.display_name`) };
  });

  route(app, deps, { method: 'POST', url: '/admin/staff/:id/revoke', tags: T, summary: 'Revoke role (takes effect on next request)', params: zIdParam, body: z.object({ role: z.string(), reason: z.string().min(3) }) }, async ({ actor, db, params, body }) => {
    requirePerm(actor, 'staff.manage'); requireStepUp(actor);
    if (params.id === actor.userId && body.role === 'owner') throw conflict('CANNOT_REVOKE_OWN_OWNER_ROLE');
    const r = await db.query(`UPDATE memberships SET revoked_at=now() WHERE user_id=$1 AND role_code=$2 AND revoked_at IS NULL RETURNING id`, [params.id, body.role]);
    if (!r.rowCount) throw notFound('MEMBERSHIP');
    await audit(db, actor, 'staff.role_revoked', { type: 'user', id: params.id }, { after: { role: body.role }, reason: body.reason });
    return { ok: true };
  });

  // ---------- Business policies (Appendix B) ----------
  route(app, deps, { method: 'GET', url: '/admin/policies', tags: T, summary: 'Policy registry' }, async ({ actor, db }) => {
    requirePerm(actor, 'policies.manage');
    return { items: await many(db, `SELECT * FROM business_policies ORDER BY key, version DESC`) };
  });
  route(app, deps, { method: 'POST', url: '/admin/policies', tags: T, summary: 'New draft policy version', body: z.object({ key: z.string().min(3).max(80), value: z.record(z.string(), z.unknown()), source_note: z.string().min(3).max(500), effective_at: z.string().datetime().optional() }) },
    async ({ actor, db, body }) => {
      requirePerm(actor, 'policies.manage');
      return withTx(db, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`policy:${body.key}`]);
        const v = await one<{ v: number }>(tx, `SELECT COALESCE(MAX(version),0)+1 AS v FROM business_policies WHERE key=$1`, [body.key]);
        const r = await one(tx, `INSERT INTO business_policies (key, version, value, status, is_demo, owner_user_id, effective_at, source_note) VALUES ($1,$2,$3,'draft',false,$4,COALESCE($5::timestamptz, now()),$6) RETURNING id, version`, [body.key, v.v, JSON.stringify(body.value), actor.userId, body.effective_at ?? null, body.source_note]);
        await audit(tx, actor, 'policy.drafted', { type: 'policy', id: body.key }, { after: body.value });
        return r;
      });
    });
  route(app, deps, { method: 'POST', url: '/admin/policies/:id/approve', tags: T, summary: 'Approve policy version (owner)', params: zIdParam }, async ({ actor, db, params }) => {
    requirePerm(actor, 'policies.manage'); requireStepUp(actor);
    const r = await db.query(`UPDATE business_policies SET status='approved', approved_by=$2, approved_at=now() WHERE id=$1 AND status='draft' RETURNING key, version`, [params.id, actor.userId]);
    if (!r.rowCount) throw conflict('POLICY_NOT_DRAFT');
    await audit(db, actor, 'policy.approved', { type: 'policy', id: r.rows[0].key }, { after: { version: r.rows[0].version } });
    return { ok: true };
  });

  // ---------- Delivery zones (§16) ----------
  route(app, deps, { method: 'POST', url: '/admin/delivery-zones', tags: T, summary: 'Create delivery zone',
    body: z.object({ region_code: z.string(), district: z.string().max(120).optional(), name: zLocalized, tariff_minor: z.string().regex(/^\d+$/), free_from_minor: z.string().regex(/^[1-9]\d*$/).optional(), eta_min_days: z.number().int().min(0), eta_max_days: z.number().int().min(0), cod_allowed: z.boolean().default(true) }) },
  async ({ actor, db, body }) => {
    requirePerm(actor, 'delivery_zones.write');
    const r = await one(db, `INSERT INTO delivery_zones (region_code, district, name, tariff_minor, free_from_minor, eta_min_days, eta_max_days, cod_allowed) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [body.region_code, body.district ?? null, JSON.stringify(body.name), body.tariff_minor, body.free_from_minor ?? null, body.eta_min_days, body.eta_max_days, body.cod_allowed]);
    await audit(db, actor, 'delivery_zone.created', { type: 'delivery_zone', id: (r as { id: string }).id }, { after: body });
    return r;
  });
  route(app, deps, { method: 'POST', url: '/admin/delivery-zones/:id/deactivate', tags: T, summary: 'Deactivate zone', params: zIdParam }, async ({ actor, db, params }) => {
    requirePerm(actor, 'delivery_zones.write');
    await db.query(`UPDATE delivery_zones SET active=false, version=version+1 WHERE id=$1`, [params.id]);
    await audit(db, actor, 'delivery_zone.deactivated', { type: 'delivery_zone', id: params.id });
    return { ok: true };
  });

  // ---------- Promo codes (§10): transactional limit, explicit validity window with timezone offset ----------
  route(app, deps, { method: 'GET', url: '/admin/promotions', tags: T, summary: 'Promotions' }, async ({ actor, db }) => {
    requirePerm(actor, 'catalog.write');
    return { items: await many(db, `SELECT id, code, name, kind, value_bps, value_minor::text, min_subtotal_minor::text, starts_at, ends_at, max_redemptions, redemptions_reserved, status FROM promotions ORDER BY created_at DESC LIMIT 200`) };
  });
  route(app, deps, { method: 'POST', url: '/admin/promotions', tags: T, summary: 'Create promo code (ISO times with offset, e.g. 2026-11-03T00:00:00+05:00)',
    body: z.object({ code: z.string().regex(/^[A-Z0-9]{4,20}$/), name: zLocalized, kind: z.enum(['cart_percent', 'cart_fixed', 'free_delivery']), value_bps: z.number().int().min(1).max(10000).optional(), value_minor: z.string().regex(/^[1-9]\d{0,15}$/).optional(),
      min_subtotal_minor: z.string().regex(/^\d{1,16}$/).default('0'), starts_at: z.string().datetime({ offset: true }), ends_at: z.string().datetime({ offset: true }), max_redemptions: z.number().int().min(1).optional(), funding_owner: z.enum(['platform', 'brand']).default('platform') }) },
  async ({ actor, db, body }) => {
    requirePerm(actor, 'catalog.write');
    if (new Date(body.ends_at) <= new Date(body.starts_at)) throw badRequest('PROMO_WINDOW_INVALID');
    if ((body.kind === 'cart_percent') !== (body.value_bps !== undefined) || (body.kind === 'cart_fixed') !== (body.value_minor !== undefined)) throw badRequest('PROMO_SHAPE_INVALID');
    const r = await one(db, `INSERT INTO promotions (code, name, kind, value_bps, value_minor, min_subtotal_minor, funding_owner, starts_at, ends_at, max_redemptions) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, starts_at, ends_at`,
      [body.code, JSON.stringify(body.name), body.kind, body.value_bps ?? null, body.value_minor ?? null, body.min_subtotal_minor, body.funding_owner, body.starts_at, body.ends_at, body.max_redemptions ?? null]);
    await audit(db, actor, 'promotion.created', { type: 'promotion', id: (r as { id: string }).id }, { after: body });
    return r;
  });
  route(app, deps, { method: 'POST', url: '/admin/promotions/:id/pause', tags: T, summary: 'Pause promotion', params: zIdParam }, async ({ actor, db, params }) => {
    requirePerm(actor, 'catalog.write');
    const r = await db.query(`UPDATE promotions SET status='paused', version=version+1 WHERE id=$1 RETURNING id`, [params.id]);
    if (!r.rowCount) throw notFound('PROMOTION');
    await audit(db, actor, 'promotion.paused', { type: 'promotion', id: params.id });
    return { ok: true };
  });

  // ---------- Feature flags (e.g. ai.enabled): owner + step-up, audited ----------
  route(app, deps, { method: 'GET', url: '/admin/feature-flags', tags: T, summary: 'Feature flags' }, async ({ actor, db }) => {
    requirePerm(actor, 'policies.manage');
    return { items: await many(db, `SELECT key, enabled, description, updated_at, version FROM feature_flags ORDER BY key`) };
  });
  route(app, deps, { method: 'POST', url: '/admin/feature-flags/:key', tags: T, summary: 'Enable/disable a feature flag (kill switch)', params: z.object({ key: z.string().regex(/^[a-z0-9_.]{2,60}$/) }), body: z.object({ enabled: z.boolean(), reason: z.string().min(3).max(300) }) },
    async ({ actor, db, params, body }) => {
      requirePerm(actor, 'policies.manage'); requireStepUp(actor);
      const r = await db.query(`UPDATE feature_flags SET enabled=$2, updated_by=$3, updated_at=now(), version=version+1 WHERE key=$1 RETURNING key, enabled, version`, [params.key, body.enabled, actor.userId]);
      if (!r.rowCount) throw notFound('FEATURE_FLAG');
      await audit(db, actor, 'feature_flag.changed', { type: 'feature_flag', id: params.key }, { after: { enabled: body.enabled }, reason: body.reason });
      return r.rows[0];
    });
  // Public, read-only: which optional features the UI may show (no secrets).
  route(app, deps, { method: 'GET', url: '/features', tags: T, summary: 'Public feature availability' }, async ({ db }) => {
    const r = await many<{ key: string; enabled: boolean }>(db, `SELECT key, enabled FROM feature_flags WHERE key IN ('ai.enabled')`);
    // Support contact is configuration (SUPPORT_TELEGRAM=@username or https://t.me/...), never hard-coded.
    const sup = (process.env.SUPPORT_TELEGRAM ?? '').trim();
    const support = sup ? (sup.startsWith('https://') ? sup : `https://t.me/${sup.replace(/^@/, '')}`) : null;
    return { ...Object.fromEntries(r.map((x) => [x.key, x.enabled])), support_telegram: support, demo: deps.cfg.env !== 'production', push: fcmConfigured() };
  });

  route(app, deps, { method: 'GET', url: '/admin/audit', tags: T, summary: 'Audit log', query: z.object({ target_type: z.string().optional(), target_id: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }) },
    async ({ actor, db, query }) => {
      requirePerm(actor, 'audit.read');
      return { items: await many(db, `SELECT a.*, u.display_name AS actor_name FROM audit_events a LEFT JOIN users u ON u.id=a.actor_user_id WHERE ($1::text IS NULL OR target_type=$1) AND ($2::text IS NULL OR target_id=$2) ORDER BY id DESC LIMIT $3`, [query.target_type ?? null, query.target_id ?? null, query.limit]) };
    });

  // ---------- Owner reports (§21): every metric named, dates typed, TZ explicit ----------
  const zRange = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), date_type: z.enum(['created', 'paid', 'delivered']).default('created') });
  const dateCol = (t: string) => (t === 'paid' ? 'o.paid_at' : t === 'delivered' ? 'o.delivered_at' : 'o.created_at');

  route(app, deps, { method: 'GET', url: '/admin/reports/summary', tags: T, summary: 'Owner summary (Asia/Tashkent day bounds, inclusive)', query: zRange }, async ({ actor, db, query }) => {
    requirePerm(actor, 'reports.read');
    const col = dateCol(query.date_type);
    const range = `${col} >= ($1::date::timestamp AT TIME ZONE '${TZ}') AND ${col} < (($2::date + 1)::timestamp AT TIME ZONE '${TZ}')`;
    const s = await one<Record<string, string>>(db, `
      SELECT COUNT(*)::int AS orders_created,
             COUNT(*) FILTER (WHERE o.confirmation_status='verified')::int AS orders_confirmed,
             COALESCE(SUM(o.payable_minor),0)::text AS created_order_total_minor,
             COALESCE(SUM(o.payable_minor) FILTER (WHERE o.payment_status IN ('paid','partially_refunded','refunded')),0)::text AS paid_total_minor,
             COUNT(*) FILTER (WHERE o.fulfillment_status='delivered')::int AS orders_delivered,
             COALESCE(SUM(pi.refunded_minor),0)::text AS refunded_minor,
             COALESCE(SUM(pi.captured_minor - pi.refunded_minor),0)::text AS actual_net_receipts_minor
        FROM orders o LEFT JOIN payment_intents pi ON pi.order_id=o.id WHERE ${range}`, [query.from, query.to]);
    const cod = await one<Record<string, string>>(db, `SELECT COALESCE(SUM(collected_minor) FILTER (WHERE status IN ('with_courier','remitted','discrepancy')),0)::text AS cod_pending_minor FROM cod_collections`);
    const comm = await one<Record<string, string>>(db, `SELECT COALESCE(SUM(estimated_minor),0)::text AS estimated, COALESCE(SUM(pending_minor),0)::text AS pending, COALESCE(SUM(available_minor + reserved_minor),0)::text AS payable, COALESCE(SUM(paid_minor),0)::text AS paid, COALESCE(SUM(debt_minor),0)::text AS debt FROM partner_balances`);
    const margin = await one<{ goods: string; cost: string; missing_cost: number; commission: string }>(db, `
      SELECT COALESCE(SUM(ol.line_net_minor - ol.refunded_product_minor),0)::text AS goods,
             COALESCE(SUM(ol.cost_snapshot_minor * (ol.delivered_qty - ol.returned_qty)),0)::text AS cost,
             COUNT(*) FILTER (WHERE ol.cost_snapshot_minor IS NULL)::int AS missing_cost,
             COALESCE((SELECT SUM(a.target_minor) FROM commission_accruals a JOIN orders o2 ON o2.id=a.order_id WHERE a.state<>'superseded' AND ${range.replaceAll('o.', 'o2.')}),0)::text AS commission
        FROM order_lines ol JOIN orders o ON o.id=ol.order_id WHERE o.fulfillment_status='delivered' AND ${range}`, [query.from, query.to]);
    // Never labelled "net profit": PSP fees, shop-paid delivery and ad costs are not fully recorded yet (T082).
    const complete = margin.missing_cost === 0;
    return {
      timezone: TZ, date_type: query.date_type, from: query.from, to: query.to, ...s, ...cod,
      commission_obligation: comm,
      estimated_operating_margin: {
        label: complete ? 'estimated_margin_partial_costs' : 'incomplete_missing_cost',
        goods_revenue_minor: margin.goods, cost_minor: margin.cost, commission_minor: margin.commission,
        value_minor: (BigInt(margin.goods) - BigInt(margin.cost) - BigInt(margin.commission)).toString(),
        missing: [...(complete ? [] : ['cost_price']), 'payment_fees', 'shop_paid_delivery', 'ad_spend', 'other_expenses'],
      },
    };
  });

  route(app, deps, { method: 'GET', url: '/admin/reports/orders.csv', tags: T, summary: 'CSV export (masked phones, formula-safe)', query: zRange }, async ({ actor, db, query, reply }) => {
    requirePerm(actor, 'reports.read');
    const col = dateCol(query.date_type);
    const rows = await many(db, `SELECT o.number, o.created_at AT TIME ZONE '${TZ}' AS created_local, o.channel, o.commercial_status, o.payment_status, o.fulfillment_status, o.payable_minor::text, o.customer_phone, o.contact_snapshot->>'name' AS customer_name, p.code AS partner_code
        FROM orders o LEFT JOIN partners p ON p.id=o.attributed_partner_id WHERE ${col} >= ($1::date::timestamp AT TIME ZONE '${TZ}') AND ${col} < (($2::date + 1)::timestamp AT TIME ZONE '${TZ}') ORDER BY o.created_at`, [query.from, query.to]);
    const header = ['number', 'created_local', 'channel', 'commercial_status', 'payment_status', 'fulfillment_status', 'payable_minor', 'customer_phone_masked', 'customer_name', 'partner_code'];
    const body = rows.map((r) => [r.number, r.created_local, r.channel, r.commercial_status, r.payment_status, r.fulfillment_status, r.payable_minor, maskPhone(String(r.customer_phone ?? '')), r.customer_name, r.partner_code].map(csvCell).join(','));
    await audit(db, actor, 'report.exported', { type: 'report', id: 'orders.csv' }, { after: { from: query.from, to: query.to, rows: rows.length } });
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="orders-${query.from}-${query.to}.csv"`);
    return reply.send([header.join(','), ...body].join('\n'));
  });

  route(app, deps, { method: 'GET', url: '/admin/reports/partners', tags: T, summary: 'Per-partner sales & commission', query: zRange }, async ({ actor, db, query }) => {
    requirePerm(actor, 'reports.read');
    return { items: await many(db, `SELECT p.code, p.display_name, COUNT(o.id)::int AS orders, COUNT(o.id) FILTER (WHERE o.fulfillment_status='delivered')::int AS delivered,
        COALESCE(SUM(o.payable_minor) FILTER (WHERE o.payment_status='paid'),0)::text AS paid_minor, (SELECT COALESCE(SUM(target_minor),0)::text FROM commission_accruals a WHERE a.partner_id=p.id AND a.state<>'superseded') AS commission_minor
        FROM partners p LEFT JOIN orders o ON o.attributed_partner_id=p.id AND o.created_at >= ($1::date::timestamp AT TIME ZONE '${TZ}') AND o.created_at < (($2::date + 1)::timestamp AT TIME ZONE '${TZ}')
       GROUP BY p.id ORDER BY orders DESC`, [query.from, query.to]) };
  });

  route(app, deps, { method: 'GET', url: '/admin/integrations', tags: T, summary: 'Integration status (honest: mock/sandbox/live)' }, async ({ actor, cfg }) => {
    requirePerm(actor, 'reports.read');
    return {
      items: [
        { key: 'payme', mode: cfg.payments.payme.mode, live_verified: false, note: 'Merchant API adapter + contract tests; needs merchant contract & keys' },
        { key: 'click', mode: cfg.payments.click.mode, live_verified: false, note: 'Prepare/Complete adapter + contract tests; needs service id & secret' },
        { key: 'sms', mode: 'dev_log', live_verified: false, note: 'No SMS provider configured; messages are only logged in dev' },
        { key: 'telegram', mode: 'not_configured', live_verified: false, note: 'Separate Online Magazin bot token required' },
        { key: 'fiscal', mode: 'blocked', live_verified: false, note: 'Fiscal provider contract and finance review required' },
        { key: 'ai', mode: 'disabled', live_verified: false, note: 'Feature flag off; provider/key/data policy not approved' },
      ],
    };
  });
}
