import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { z } from 'zod';
import { audit } from '../../platform/audit.js';
import { requirePerm } from '../../platform/auth.js';
import { many, maybeOne } from '../../platform/db.js';
import { AppError, badRequest, notFound } from '../../platform/errors.js';
import { type Deps, route, zIdParam } from '../../platform/http.js';
import { visitorHash } from '../partners/attribution.js';

export const VIDEO_MAX_BYTES = 40 * 1024 * 1024;
type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

/** ISO-BMFF (MP4/MOV) is recognised by the 'ftyp' box at offset 4 — never by file name. */
export function isMp4(buf: Buffer): boolean {
  return buf.length > 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp';
}

/** Stores a validated MP4 (+ optional poster image) and creates the approved video row. Used by admin upload and the DEMO seed. */
export async function saveProductVideo(db: Queryable, mediaDir: string, productId: string, buf: Buffer,
  o: { caption: Record<string, string>; rights_source: string; poster?: Buffer | null; uploadedBy: string | null; sort?: number }) {
  if (!isMp4(buf)) throw badRequest('VIDEO_TYPE_NOT_ALLOWED');
  if (buf.length > VIDEO_MAX_BYTES) throw badRequest('VIDEO_TOO_LARGE');
  const sha = createHash('sha256').update(buf).digest('hex');
  await mkdir(join(mediaDir, 'videos'), { recursive: true });
  await writeFile(join(mediaDir, 'videos', `${sha}.mp4`), buf);
  let posterKey: string | null = null;
  if (o.poster) {
    await mkdir(join(mediaDir, 'public'), { recursive: true });
    posterKey = `${sha}-w540.webp`; // matches the public /media/:key pattern
    await writeFile(join(mediaDir, 'public', posterKey), await sharp(o.poster).rotate().resize({ width: 540, withoutEnlargement: true }).webp({ quality: 78 }).toBuffer());
  }
  const r = await db.query(`INSERT INTO product_videos (product_id, storage_key, poster_key, mime, bytes, sha256, caption, rights_source, sort, uploaded_by)
      VALUES ($1,$2,$3,'video/mp4',$4,$5,$6,$7,$8,$9)
      ON CONFLICT (product_id, sha256) DO UPDATE SET status='approved', caption=EXCLUDED.caption RETURNING id`,
    [productId, `${sha}.mp4`, posterKey, buf.length, sha, JSON.stringify(o.caption), o.rights_source, o.sort ?? 0, o.uploadedBy]);
  return { id: r.rows[0].id as string, sha256: sha };
}

const FEED_SQL = `
  SELECT v.id, '/media/v/' || v.storage_key AS url, CASE WHEN v.poster_key IS NOT NULL THEN '/media/' || v.poster_key END AS poster,
         v.caption, v.likes, v.created_at,
         p.id AS product_id, p.slug, p.name,
         price.min_price::text AS price_minor, price.compare_at::text AS compare_at_minor,
         (SELECT '/media/' || ma.storage_key FROM media_assets ma WHERE ma.product_id=p.id AND ma.status='approved' ORDER BY ma.sort LIMIT 1) AS image,
         (SELECT json_agg(json_build_object('sku_id', s.id, 'variant', s.variant, 'available', GREATEST(0, COALESCE(sb.on_hand_sellable - sb.reserved - sb.safety_buffer, 0))) ORDER BY s.sku_code)
            FROM skus s JOIN offers o ON o.sku_id=s.id AND o.status='active' LEFT JOIN stock_balances sb ON sb.sku_id=s.id WHERE s.product_id=p.id AND s.status='active') AS variants
    FROM product_videos v JOIN products p ON p.id=v.product_id AND p.status='published'
    JOIN LATERAL (SELECT MIN(o.price_minor) AS min_price, MAX(o.compare_at_minor) FILTER (WHERE o.compare_at_minor > o.price_minor) AS compare_at
                    FROM skus s JOIN offers o ON o.sku_id=s.id AND o.status='active' WHERE s.product_id=p.id AND s.status='active') price ON price.min_price IS NOT NULL
   WHERE v.status='approved'`;

export function registerVideos(app: FastifyInstance, deps: Deps): void {
  const T = ['reels'];

  route(app, deps, { method: 'GET', url: '/reels', tags: T, summary: 'Vertical video feed (newest first) with product, price and like state', query: z.object({ product: z.string().max(140).optional(), limit: z.coerce.number().int().min(1).max(30).default(12), offset: z.coerce.number().int().min(0).max(5000).default(0) }) },
    async ({ actor, db, query }) => {
      const params: unknown[] = [];
      let extra = '';
      if (query.product) { params.push(query.product); extra = ` AND p.slug=$${params.length}`; }
      params.push(query.limit, query.offset);
      const rows = await many(db, `${FEED_SQL}${extra} ORDER BY v.sort, v.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
      let liked = new Set<string>();
      if (actor.guestToken && rows.length) {
        const r = await db.query(`SELECT video_id FROM video_likes WHERE visitor_hash=$1 AND video_id = ANY($2::uuid[])`, [visitorHash(actor.guestToken), rows.map((x) => x.id)]);
        liked = new Set(r.rows.map((x: { video_id: string }) => x.video_id));
      }
      return { items: rows.map((r) => ({ ...r, liked: liked.has(r.id as string) })) };
    });

  route(app, deps, { method: 'POST', url: '/reels/:id/like', tags: T, summary: 'Toggle like (one per visitor)', params: zIdParam, body: z.object({ like: z.boolean() }) },
    async ({ actor, db, params, body }) => {
      if (!actor.guestToken) throw badRequest('GUEST_TOKEN_REQUIRED');
      const h = visitorHash(actor.guestToken);
      if (!(await maybeOne(db, `SELECT 1 FROM product_videos WHERE id=$1 AND status='approved'`, [params.id]))) throw notFound('VIDEO');
      const changed = body.like
        ? await db.query(`INSERT INTO video_likes (video_id, visitor_hash) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [params.id, h])
        : await db.query(`DELETE FROM video_likes WHERE video_id=$1 AND visitor_hash=$2`, [params.id, h]);
      const r = changed.rowCount
        ? await db.query(`UPDATE product_videos SET likes = GREATEST(0, likes + $2) WHERE id=$1 RETURNING likes`, [params.id, body.like ? 1 : -1])
        : await db.query(`SELECT likes FROM product_videos WHERE id=$1`, [params.id]);
      return { liked: body.like, likes: r.rows[0].likes };
    });

  route(app, deps, { method: 'POST', url: '/reels/:id/view', tags: T, summary: 'Count a view (best effort)', params: zIdParam },
    async ({ db, params }) => { await db.query(`UPDATE product_videos SET views = views + 1 WHERE id=$1 AND status='approved'`, [params.id]); return { ok: true }; });

  route(app, deps, {
    method: 'POST', url: '/admin/products/:id/videos', tags: ['catalog'], summary: 'Upload product video: raw MP4 body (Content-Type: video/mp4, ≤40MB, H.264 recommended); caption via query',
    params: zIdParam, query: z.object({ caption: z.string().max(300).optional() }), bodyLimit: VIDEO_MAX_BYTES,
  }, async ({ actor, db, cfg, params, query, req }) => {
    requirePerm(actor, 'catalog.write');
    if (!(await maybeOne(db, `SELECT 1 FROM products WHERE id=$1`, [params.id]))) throw notFound('PRODUCT');
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) throw badRequest('VIDEO_BODY_REQUIRED');
    const v = await saveProductVideo(db, cfg.mediaDir, params.id, buf, { caption: query.caption ? { 'uz-Latn': query.caption } : {}, rights_source: 'owner upload', uploadedBy: actor.userId });
    await audit(db, actor, 'video.uploaded', { type: 'product', id: params.id }, { after: { video_id: v.id, sha256: v.sha256, bytes: buf.length } });
    return { id: v.id, bytes: buf.length };
  });

  route(app, deps, { method: 'GET', url: '/admin/products/:id/videos', tags: ['catalog'], summary: 'Product videos', params: zIdParam }, async ({ actor, db, params }) => {
    requirePerm(actor, 'catalog.write');
    return { items: await many(db, `SELECT id, '/media/v/' || storage_key AS url, CASE WHEN poster_key IS NOT NULL THEN '/media/' || poster_key END AS poster, bytes, likes, views, caption, created_at FROM product_videos WHERE product_id=$1 AND status='approved' ORDER BY sort, created_at DESC`, [params.id]) };
  });

  route(app, deps, { method: 'DELETE', url: '/admin/videos/:id', tags: ['catalog'], summary: 'Remove video from the storefront (kept for audit)', params: zIdParam }, async ({ actor, db, params }) => {
    requirePerm(actor, 'catalog.write');
    const r = await db.query(`UPDATE product_videos SET status='rejected' WHERE id=$1 AND status='approved' RETURNING product_id`, [params.id]);
    if (!r.rowCount) throw notFound('VIDEO');
    await audit(db, actor, 'video.removed', { type: 'product', id: r.rows[0].product_id }, { after: { video_id: params.id } });
    return { ok: true };
  });
}

/** Public video file with HTTP Range support (mobile players seek/stream). Names are content hashes only. */
export function registerVideoServe(app: FastifyInstance, deps: Deps): void {
  app.get('/media/v/:key', { schema: { hide: true } }, async (req, reply) => {
    const key = (req.params as { key: string }).key;
    if (!/^[a-f0-9]{64}\.mp4$/.test(key)) throw new AppError(404, 'MEDIA_NOT_FOUND');
    const file = join(deps.cfg.mediaDir, 'videos', key);
    let size: number;
    try { size = (await stat(file)).size; } catch { throw new AppError(404, 'MEDIA_NOT_FOUND'); }
    reply.header('content-type', 'video/mp4').header('accept-ranges', 'bytes').header('cache-control', 'public, max-age=31536000, immutable').header('x-content-type-options', 'nosniff');
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : size - 1;
      if (start < 0) start = 0;
      if (end >= size) end = size - 1;
      if (start > end || start >= size) return reply.code(416).header('content-range', `bytes */${size}`).send();
      reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`).header('content-length', end - start + 1);
      return reply.send(createReadStream(file, { start, end }));
    }
    reply.header('content-length', size);
    return reply.send(createReadStream(file));
  });
}
