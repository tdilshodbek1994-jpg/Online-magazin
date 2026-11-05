import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, mkProduct, setupApp, staff, type Staff, type T } from './helpers.js';

let t: T;
let s: Staff;
let mp4: Buffer;
beforeAll(async () => {
  t = await setupApp();
  s = await staff(t);
  mp4 = await readFile(new URL('../demo-assets/videos/smartfon-nova-12.mp4', import.meta.url));
});
const guestTok = () => randomUUID() + randomUUID();
const upload = (token: string, productId: string, body: Buffer, caption = 'Sharh') =>
  api(t, 'POST', `/admin/products/${productId}/videos?caption=${encodeURIComponent(caption)}`, { token, body, headers: { 'content-type': 'video/mp4' } });

describe('Reels', () => {
  it('catalog manager uploads an MP4; it appears in the feed with product price and buyable variants; streams with Range', async () => {
    const prod = await mkProduct(t, { prices: [120_000], stock: [4] });
    const up = await upload(s.catalog.token, prod.productId, mp4, 'Yangi model');
    expect(up.status).toBe(200);
    const feed = await api(t, 'GET', `/reels?product=${prod.slug}`, { guest: guestTok() });
    expect(feed.status).toBe(200);
    const v = feed.json.items[0];
    expect(v).toMatchObject({ id: up.json.id, slug: prod.slug, price_minor: '12000000', likes: 0, liked: false });
    expect(v.caption['uz-Latn']).toBe('Yangi model');
    expect(v.variants[0]).toMatchObject({ sku_id: prod.skuIds[0], available: 4 });

    const full = await api(t, v.url.startsWith('/media') ? 'GET' : 'GET', v.url);
    expect(full.status).toBe(200);
    expect(full.raw.headers['content-type']).toBe('video/mp4');
    expect(Number(full.raw.headers['content-length'])).toBe(mp4.length);
    const part = await api(t, 'GET', v.url, { headers: { range: 'bytes=0-99' } });
    expect(part.status).toBe(206);
    expect(part.raw.headers['content-range']).toBe(`bytes 0-99/${mp4.length}`);
    expect(part.raw.rawPayload.length).toBe(100);
    expect((await api(t, 'GET', v.url, { headers: { range: `bytes=${mp4.length + 10}-` } })).status).toBe(416);
    expect((await api(t, 'GET', '/media/v/../../etc/passwd')).status).toBe(404);
  });

  it('likes are one per visitor and toggle idempotently', async () => {
    const prod = await mkProduct(t, { prices: [10_000], stock: [1] });
    const up = await upload(s.catalog.token, prod.productId, mp4);
    const g1 = guestTok(), g2 = guestTok();
    expect((await api(t, 'POST', `/reels/${up.json.id}/like`, { guest: g1, body: { like: true } })).json.likes).toBe(1);
    expect((await api(t, 'POST', `/reels/${up.json.id}/like`, { guest: g1, body: { like: true } })).json.likes).toBe(1); // double tap
    expect((await api(t, 'POST', `/reels/${up.json.id}/like`, { guest: g2, body: { like: true } })).json.likes).toBe(2);
    expect((await api(t, 'GET', `/reels?product=${prod.slug}`, { guest: g1 })).json.items[0].liked).toBe(true);
    expect((await api(t, 'POST', `/reels/${up.json.id}/like`, { guest: g1, body: { like: false } })).json.likes).toBe(1);
    expect((await api(t, 'POST', `/reels/${up.json.id}/like`, { guest: g1, body: { like: false } })).json.likes).toBe(1);
  });

  it('rejects non-MP4 bytes and non-catalog users; removed videos leave the feed', async () => {
    const prod = await mkProduct(t, { prices: [10_000], stock: [1] });
    const bad = await upload(s.catalog.token, prod.productId, Buffer.from('<html><script>alert(1)</script></html>'));
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe('VIDEO_TYPE_NOT_ALLOWED');
    expect((await upload(s.operator.token, prod.productId, mp4)).status).toBe(403);
    const up = await upload(s.catalog.token, prod.productId, mp4);
    expect((await api(t, 'GET', `/admin/products/${prod.productId}/videos`, { token: s.catalog.token })).json.items).toHaveLength(1);
    expect((await api(t, 'DELETE', `/admin/videos/${up.json.id}`, { token: s.catalog.token })).status).toBe(200);
    expect((await api(t, 'GET', `/reels?product=${prod.slug}`)).json.items).toHaveLength(0);
    expect((await api(t, 'POST', `/reels/${up.json.id}/like`, { guest: guestTok(), body: { like: true } })).status).toBe(404);
  });
});
