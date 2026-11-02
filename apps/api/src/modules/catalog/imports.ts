import { normalizeSearch, slugify } from '@om/shared';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../platform/audit.js';
import { requirePerm } from '../../platform/auth.js';
import { maybeOne, one, withTx } from '../../platform/db.js';
import { badRequest, conflict, notFound } from '../../platform/errors.js';
import { type Deps, route, zIdParam } from '../../platform/http.js';
import { moveStock } from '../inventory/service.js';
import { ownerOrgId } from './routes.js';

/** RFC 4180 CSV parser (quotes, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',' || c === ';') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

const COLS = ['sku_code', 'product_slug', 'name_uz_latn', 'name_uz_cyrl', 'category_slug', 'price_som', 'cost_som', 'stock_receipt', 'brand', 'variant'] as const;
type Row = Record<(typeof COLS)[number], string>;
interface Valid { line: number; action: 'create_product' | 'create_sku' | 'update_price' | 'no_change'; row: Row; price_minor: string; cost_minor: string | null; stock: number; category_id: string; variant: Record<string, string> }

const somToMinor = (s: string): string | null => (/^\d{1,13}(\.\d{1,2})?$/.test(s) ? String(BigInt(s.split('.')[0]!) * 100n + BigInt((s.split('.')[1] ?? '0').padEnd(2, '0'))) : null);

export function registerImports(app: FastifyInstance, deps: Deps): void {
  const T = ['catalog'];
  route(app, deps, { method: 'POST', url: '/admin/imports/products/preview', tags: T, summary: 'CSV dry-run: per-row validation and planned changes (nothing written)', body: z.object({ csv: z.string().min(1).max(2_000_000) }) },
    async ({ actor, db, body }) => {
      requirePerm(actor, 'catalog.write');
      const org = await ownerOrgId(db);
      const rows = parseCsv(body.csv.replace(/^﻿/, ''));
      const header = (rows.shift() ?? []).map((h) => h.trim().toLowerCase());
      const missing = ['sku_code', 'name_uz_latn', 'category_slug', 'price_som'].filter((c) => !header.includes(c));
      if (missing.length) throw badRequest('CSV_HEADER_INVALID', Object.fromEntries(missing.map((m) => [m, 'validation.required'])));
      if (rows.length > 10_000) throw badRequest('CSV_TOO_MANY_ROWS');
      const errors: { line: number; field: string; code: string }[] = [];
      const valid: Valid[] = [];
      const seen = new Set<string>();
      const cats = new Map((await db.query(`SELECT slug, id FROM categories`)).rows.map((r) => [r.slug as string, r.id as string]));
      const existing = new Map((await db.query(`SELECT s.sku_code, o.price_minor, p.slug FROM skus s JOIN products p ON p.id=s.product_id JOIN offers o ON o.sku_id=s.id AND o.merchant_org_id=$1`, [org])).rows.map((r) => [r.sku_code as string, r]));
      rows.forEach((cells, i) => {
        const line = i + 2;
        const r = Object.fromEntries(COLS.map((c) => [c, (cells[header.indexOf(c)] ?? '').trim()])) as Row;
        const err = (field: string, code: string) => errors.push({ line, field, code });
        const before = errors.length;
        if (!/^[A-Za-z0-9._-]{2,64}$/.test(r.sku_code)) err('sku_code', 'invalid');
        else if (seen.has(r.sku_code)) err('sku_code', 'duplicate_in_file');
        seen.add(r.sku_code);
        if (!r.name_uz_latn) err('name_uz_latn', 'required');
        const cat = cats.get(r.category_slug);
        if (!cat) err('category_slug', 'unknown');
        const price = somToMinor(r.price_som);
        if (!price || price === '0') err('price_som', 'invalid');
        const cost = r.cost_som ? somToMinor(r.cost_som) : null;
        if (r.cost_som && !cost) err('cost_som', 'invalid');
        const stock = r.stock_receipt ? Number(r.stock_receipt) : 0;
        if (!Number.isInteger(stock) || stock < 0 || stock > 100000) err('stock_receipt', 'invalid');
        const variant: Record<string, string> = {};
        for (const kv of r.variant ? r.variant.split('|') : []) {
          const [k, v] = kv.split('=');
          if (!k || !v) err('variant', 'invalid'); else variant[k.trim()] = v.trim();
        }
        if (errors.length > before) return;
        const ex = existing.get(r.sku_code);
        const action = !ex ? ((r.product_slug && [...existing.values()].some((e) => e.slug === r.product_slug)) ? 'create_sku' : 'create_product') : ex.price_minor === price ? 'no_change' : 'update_price';
        valid.push({ line, action, row: r, price_minor: price!, cost_minor: cost, stock, category_id: cat!, variant });
      });
      const hash = createHash('sha256').update(body.csv).digest('hex');
      const b = await one<{ id: string }>(db, `INSERT INTO import_batches (organization_id, kind, status, file_sha256, total_rows, accepted_rows, rejected_rows, errors, rows, created_by) VALUES ($1,'products_csv','preview',$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [org, hash, rows.length, valid.length, rows.length - valid.length, JSON.stringify(errors), JSON.stringify(valid), actor.userId]);
      const summary = valid.reduce<Record<string, number>>((a, v) => ({ ...a, [v.action]: (a[v.action] ?? 0) + 1 }), {});
      return { batch_id: b.id, total_rows: rows.length, valid_rows: valid.length, rejected_rows: rows.length - valid.length, changes: summary, stock_units_to_receive: valid.reduce((a, v) => a + v.stock, 0), errors };
    });

  route(app, deps, { method: 'POST', url: '/admin/imports/:id/commit', tags: T, summary: 'Commit a previewed batch (valid rows only; idempotent)', params: zIdParam }, async ({ actor, db, params }) => {
    requirePerm(actor, 'catalog.write');
    return withTx(db, async (tx) => {
      const b = await maybeOne<{ status: string; rows: Valid[]; result: unknown; created_at: string }>(tx, `SELECT status, rows, result, created_at FROM import_batches WHERE id=$1 FOR UPDATE`, [params.id]);
      if (!b) throw notFound('IMPORT');
      if (b.status === 'committed') return { ...(b.result as object), replayed: true };
      if (b.status !== 'preview') throw conflict('IMPORT_NOT_COMMITTABLE');
      if (Date.now() - new Date(b.created_at).getTime() > 3600_000) throw conflict('IMPORT_PREVIEW_EXPIRED');
      const org = await ownerOrgId(tx);
      const wh = (await tx.query(`SELECT id FROM warehouses WHERE code='MAIN'`)).rows[0].id;
      const counts: Record<string, number> = {};
      for (const v of b.rows) {
        const r = v.row;
        let sku = await maybeOne<{ id: string; offer_id: string; price_minor: string; version: number }>(tx, `SELECT s.id, o.id AS offer_id, o.price_minor, o.version FROM skus s JOIN offers o ON o.sku_id=s.id AND o.merchant_org_id=$2 WHERE s.sku_code=$1`, [r.sku_code, org]);
        let action = 'no_change';
        if (!sku) {
          const slug = r.product_slug || slugify(r.name_uz_latn);
          let prod = await maybeOne<{ id: string }>(tx, `SELECT id FROM products WHERE slug=$1`, [slug]);
          if (!prod) {
            const name = { 'uz-Latn': r.name_uz_latn, ...(r.name_uz_cyrl ? { 'uz-Cyrl': r.name_uz_cyrl } : {}) };
            const brand = r.brand ? (await one<{ id: string }>(tx, `INSERT INTO brands (slug, name) VALUES ($1,$2) ON CONFLICT (slug) DO UPDATE SET name=brands.name RETURNING id`, [slugify(r.brand) || 'brand', r.brand])).id : null;
            prod = await one(tx, `INSERT INTO products (owner_org_id, category_id, brand_id, slug, name, search_doc, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
              [org, v.category_id, brand, slug, JSON.stringify(name), normalizeSearch([r.name_uz_latn, r.name_uz_cyrl, r.brand, r.sku_code].join(' ')), actor.userId]);
            action = 'create_product';
          } else action = 'create_sku';
          const variantKey = Object.keys(v.variant).sort().map((k) => `${k}=${v.variant[k]}`).join('|') || `sku=${r.sku_code}`;
          const s = await one<{ id: string }>(tx, `INSERT INTO skus (product_id, sku_code, variant, variant_key, cost_minor) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [prod!.id, r.sku_code, JSON.stringify(v.variant), variantKey, v.cost_minor]);
          const o = await one<{ id: string }>(tx, `INSERT INTO offers (sku_id, merchant_org_id, price_minor) VALUES ($1,$2,$3) RETURNING id`, [s.id, org, v.price_minor]);
          await tx.query(`INSERT INTO offer_versions (offer_id, version, price_minor, changed_by, reason) VALUES ($1,1,$2,$3,$4)`, [o.id, v.price_minor, actor.userId, `import ${params.id}`]);
          await tx.query(`INSERT INTO stock_balances (sku_id, merchant_org_id, warehouse_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [s.id, org, wh]);
          sku = { id: s.id, offer_id: o.id, price_minor: v.price_minor, version: 1 };
        } else if (sku.price_minor !== v.price_minor) {
          const nv = await one<{ version: number }>(tx, `UPDATE offers SET price_minor=$2, version=version+1, updated_at=now() WHERE id=$1 RETURNING version`, [sku.offer_id, v.price_minor]);
          await tx.query(`INSERT INTO offer_versions (offer_id, version, price_minor, changed_by, reason) VALUES ($1,$2,$3,$4,$5)`, [sku.offer_id, nv.version, v.price_minor, actor.userId, `import ${params.id}`]);
          action = 'update_price';
        }
        if (v.cost_minor) await tx.query(`UPDATE skus SET cost_minor=$2 WHERE id=$1`, [sku.id, v.cost_minor]);
        // Receipt ref is batch+line, so a retried commit never receives twice.
        if (v.stock > 0) await moveStock(tx, { skuId: sku.id, merchantOrgId: org, kind: 'receipt', bucket: 'on_hand_sellable', qty: v.stock, refType: 'import', refId: `${params.id}:${v.line}`, actorId: actor.userId, reason: 'CSV import' });
        counts[action] = (counts[action] ?? 0) + 1;
      }
      const result = { committed_rows: b.rows.length, changes: counts };
      await tx.query(`UPDATE import_batches SET status='committed', committed_at=now(), result=$2 WHERE id=$1`, [params.id, JSON.stringify(result)]);
      await audit(tx, actor, 'import.committed', { type: 'import_batch', id: params.id }, { after: result });
      return result;
    });
  });
}
