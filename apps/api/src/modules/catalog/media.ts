import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { z } from 'zod';
import { audit } from '../../platform/audit.js';
import { requirePerm } from '../../platform/auth.js';
import { maybeOne, one } from '../../platform/db.js';
import { AppError, badRequest, notFound } from '../../platform/errors.js';
import { type Deps, route, zIdParam } from '../../platform/http.js';

const MAX_BYTES = 5 * 1024 * 1024;
const WIDTHS = [320, 640, 1200];

/** Detect type from magic bytes, never from the file name/extension (§08, T030). */
export function sniff(buf: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null; // SVG/HTML/executables and anything else are rejected
}

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

/** Stores an already-validated image: original kept privately, public responsive WEBP variants, DB row (approved). Used by upload and DEMO seed. */
export async function saveProductImage(db: Queryable, mediaDir: string, productId: string, buf: Buffer,
  o: { mime: string; width: number; height: number; filename: string; alt: Record<string, string>; rights_source: string; sort: number; uploadedBy: string | null }) {
  const sha = createHash('sha256').update(buf).digest('hex');
  // Stored names derive only from the content hash; the original filename never becomes a path (§08).
  const dir = join(mediaDir, 'public');
  await mkdir(dir, { recursive: true });
  await mkdir(join(mediaDir, 'originals'), { recursive: true });
  await writeFile(join(mediaDir, 'originals', `${sha}.bin`), buf);
  const variants: Record<string, string> = {};
  for (const w of WIDTHS) {
    const key = `${sha}-w${w}.webp`;
    // Re-encoding strips metadata (EXIF/GPS) and any embedded active content.
    await writeFile(join(dir, key), await sharp(buf).rotate().resize({ width: w, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer());
    variants[`w${w}`] = key;
  }
  const r = await db.query(`INSERT INTO media_assets (product_id, storage_key, mime, width, height, bytes, sha256, alt, rights_source, sort, status, original_name, variants, uploaded_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'approved',$11,$12,$13)
      ON CONFLICT (product_id, sha256) DO UPDATE SET alt=EXCLUDED.alt, sort=EXCLUDED.sort RETURNING id`,
    [productId, variants.w640, o.mime, o.width, o.height, buf.length, sha, JSON.stringify(o.alt), o.rights_source, o.sort, o.filename.replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120), JSON.stringify(variants), o.uploadedBy]);
  return { id: r.rows[0].id as string, sha256: sha, variants };
}

export function registerMedia(app: FastifyInstance, deps: Deps): void {
  route(app, deps, {
    method: 'POST', url: '/admin/products/:id/media', tags: ['catalog'], summary: 'Upload product image (JPEG/PNG/WEBP, ≤5MB, 200–6000px); responsive WEBP variants generated',
    params: zIdParam, body: z.object({ filename: z.string().max(200), content_base64: z.string().max(7_200_000), alt: z.object({ 'uz-Latn': z.string().max(200).optional(), 'uz-Cyrl': z.string().max(200).optional() }).default({}), rights_source: z.string().min(2).max(200), sort: z.number().int().min(0).max(100).default(0) }),
  }, async ({ actor, db, cfg, params, body }) => {
    requirePerm(actor, 'catalog.write');
    if (!(await maybeOne(db, `SELECT 1 FROM products WHERE id=$1`, [params.id]))) throw notFound('PRODUCT');
    const buf = Buffer.from(body.content_base64, 'base64');
    if (buf.length === 0 || buf.length > MAX_BYTES) throw badRequest('MEDIA_SIZE_INVALID');
    const mime = sniff(buf);
    if (!mime) throw badRequest('MEDIA_TYPE_NOT_ALLOWED');
    let meta: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
    try {
      meta = await sharp(buf, { limitInputPixels: 6000 * 6000 }).metadata();
    } catch {
      throw badRequest('MEDIA_CORRUPT');
    }
    if (!meta.width || !meta.height || meta.width < 200 || meta.height < 200 || meta.width > 6000 || meta.height > 6000) throw badRequest('MEDIA_DIMENSIONS_INVALID');
    const row = await saveProductImage(db, cfg.mediaDir, params.id, buf, { mime, width: meta.width, height: meta.height, filename: body.filename, alt: body.alt, rights_source: body.rights_source, sort: body.sort, uploadedBy: actor.userId });
    const sha = row.sha256, variants = row.variants;
    await audit(db, actor, 'media.uploaded', { type: 'product', id: params.id }, { after: { sha256: sha, mime } });
    return { id: row.id, mime, width: meta.width, height: meta.height, variants };
  });

  route(app, deps, { method: 'PATCH', url: '/admin/media/:id', tags: ['catalog'], summary: 'Edit alt text / order', params: zIdParam, body: z.object({ alt: z.record(z.string(), z.string().max(200)).optional(), sort: z.number().int().min(0).max(100).optional() }) },
    async ({ actor, db, params, body }) => {
      requirePerm(actor, 'catalog.write');
      const r = await db.query(`UPDATE media_assets SET alt=COALESCE($2, alt), sort=COALESCE($3, sort) WHERE id=$1 RETURNING id`, [params.id, body.alt ? JSON.stringify(body.alt) : null, body.sort ?? null]);
      if (!r.rowCount) throw notFound('MEDIA');
      return { ok: true };
    });

}

export function registerMediaServe(app: FastifyInstance, deps: Deps): void {
  app.get('/media/:key', { schema: { hide: true } }, async (req, reply) => {
    const key = (req.params as { key: string }).key;
    if (!/^[a-f0-9]{64}-w\d{3,4}\.webp$/.test(key)) throw new AppError(404, 'MEDIA_NOT_FOUND');
    try {
      const data = await readFile(join(deps.cfg.mediaDir, 'public', key));
      return reply.header('content-type', 'image/webp').header('cache-control', 'public, max-age=31536000, immutable').header('x-content-type-options', 'nosniff').send(data);
    } catch {
      throw new AppError(404, 'MEDIA_NOT_FOUND');
    }
  });
}
