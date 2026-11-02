import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { currentStep, totpAt } from '../src/platform/mfa.js';
import { api, mkUser, setupApp, staff, type Staff, type T } from './helpers.js';

let t: T;
let s: Staff;
beforeAll(async () => {
  t = await setupApp();
  s = await staff(t);
});

describe('T020 — owner/finance MFA and step-up', () => {
  it('finance without step-up cannot approve refunds/payouts or confirm COD; TOTP step-up unlocks; replay and reused recovery codes rejected', async () => {
    const fin = await mkUser(t, ['finance'], undefined, false);
    const blocked = await api(t, 'POST', `/refunds/${randomUUID()}/approve`, { token: fin.token });
    expect(blocked.json.code).toBe('STEP_UP_REQUIRED');
    expect((await api(t, 'POST', `/admin/payouts/${randomUUID()}/approve`, { token: fin.token })).json.code).toBe('STEP_UP_REQUIRED');
    expect((await api(t, 'POST', `/finance/remittances/${randomUUID()}/confirm`, { token: fin.token, body: { received_minor: '1' } })).json.code).toBe('STEP_UP_REQUIRED');
    expect((await api(t, 'POST', '/auth/step-up', { token: fin.token, body: { code: '123456' } })).json.code).toBe('MFA_ENROLLMENT_REQUIRED');
    const en = await api(t, 'POST', '/auth/mfa/enroll', { token: fin.token });
    expect(en.json.otpauth_uri).toContain('otpauth://totp/');
    const act = await api(t, 'POST', '/auth/mfa/activate', { token: fin.token, body: { code: totpAt(en.json.secret, currentStep()) } });
    expect(act.json.recovery_codes).toHaveLength(8);
    // same step reused for step-up → replay rejected
    expect((await api(t, 'POST', '/auth/step-up', { token: fin.token, body: { code: totpAt(en.json.secret, currentStep()) } })).json.code).toBe('MFA_CODE_INVALID');
    expect((await api(t, 'POST', '/auth/step-up', { token: fin.token, body: { code: '000000' } })).status).toBe(400);
    const ok = await api(t, 'POST', '/auth/step-up', { token: fin.token, body: { code: totpAt(en.json.secret, currentStep() + 1) } });
    expect(ok.status).toBe(200);
    expect((await api(t, 'POST', `/refunds/${randomUUID()}/approve`, { token: fin.token })).status).toBe(404); // passes step-up, resource missing
    const rc = act.json.recovery_codes[0];
    expect((await api(t, 'POST', '/auth/step-up', { token: fin.token, body: { recovery_code: rc } })).json.method).toBe('recovery_code');
    expect((await api(t, 'POST', '/auth/step-up', { token: fin.token, body: { recovery_code: rc } })).json.code).toBe('MFA_CODE_INVALID');
    const audit = await t.db.query(`SELECT action FROM audit_events WHERE actor_user_id=$1 ORDER BY id`, [fin.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['mfa.enabled', 'auth.step_up', 'auth.step_up']);
    const secretStored = (await t.db.query(`SELECT secret_enc FROM user_mfa WHERE user_id=$1`, [fin.id])).rows[0].secret_enc;
    expect(secretStored).not.toContain(en.json.secret);
  });

  it('operator actions do not require step-up (only owner/finance)', async () => {
    const op = await mkUser(t, ['operator'], undefined, false);
    expect((await api(t, 'GET', '/ops/queues', { token: op.token })).status).toBe(200);
  });

  it('T020 sessions: user can list and revoke own sessions', async () => {
    const u = await mkUser(t, ['owner']);
    const list = await api(t, 'GET', '/auth/sessions', { token: u.token });
    expect(list.json.items).toHaveLength(1);
    expect(list.json.items[0].current).toBe(true);
    void s;
  });
});

describe('T029 — CSV import with preview', () => {
  it('preview reports exact row errors, commit creates without duplicates, re-import is idempotent; formula cells harmless', async () => {
    const tt = await setupApp();
    const st = await staff(tt);
    await tt.db.query(`INSERT INTO categories (slug, name) VALUES ('imp-cat','{"uz-Latn":"Import"}') ON CONFLICT DO NOTHING`);
    const sfx = randomUUID().slice(0, 6).toUpperCase();
    const csv = [
      'sku_code,product_slug,name_uz_latn,name_uz_cyrl,category_slug,price_som,cost_som,stock_receipt,brand,variant',
      `IMP-${sfx}-1,imp-${sfx},"Choynak ""Lux""",Чойнак,imp-cat,150000,90000,5,Lux,rang=oq`,
      `IMP-${sfx}-2,imp-${sfx},Choynak Lux,,imp-cat,155000.50,,3,Lux,rang=qora`,
      `IMP-${sfx}-3,,=HYPERLINK("x"),,imp-cat,abc,,1,,`,
      `IMP-${sfx}-1,,Dup,,imp-cat,1000,,0,,`,
      `IMP-${sfx}-4,,Noma'lum,,no-such-cat,1000,,0,,`,
    ].join('\r\n');
    const pv = await api(tt, 'POST', '/admin/imports/products/preview', { token: st.catalog.token, body: { csv } });
    expect(pv.status).toBe(200);
    expect(pv.json).toMatchObject({ total_rows: 5, valid_rows: 2, rejected_rows: 3, stock_units_to_receive: 8 });
    expect(pv.json.errors).toEqual(expect.arrayContaining([{ line: 4, field: 'price_som', code: 'invalid' }, { line: 5, field: 'sku_code', code: 'duplicate_in_file' }, { line: 6, field: 'category_slug', code: 'unknown' }]));
    expect((await tt.db.query(`SELECT COUNT(*)::int n FROM skus WHERE sku_code LIKE $1`, [`IMP-${sfx}-%`])).rows[0].n).toBe(0); // dry-run wrote nothing
    const c1 = await api(tt, 'POST', `/admin/imports/${pv.json.batch_id}/commit`, { token: st.catalog.token });
    expect(c1.json.committed_rows).toBe(2);
    const c1b = await api(tt, 'POST', `/admin/imports/${pv.json.batch_id}/commit`, { token: st.catalog.token });
    expect(c1b.json.replayed).toBe(true);
    const skus = await tt.db.query(`SELECT s.sku_code, o.price_minor, sb.on_hand_sellable, p.status FROM skus s JOIN offers o ON o.sku_id=s.id JOIN stock_balances sb ON sb.sku_id=s.id JOIN products p ON p.id=s.product_id WHERE s.sku_code LIKE $1 ORDER BY s.sku_code`, [`IMP-${sfx}-%`]);
    expect(skus.rows).toEqual([
      { sku_code: `IMP-${sfx}-1`, price_minor: '15000000', on_hand_sellable: 5, status: 'draft' },
      { sku_code: `IMP-${sfx}-2`, price_minor: '15500050', on_hand_sellable: 3, status: 'draft' },
    ]);
    const pv2 = await api(tt, 'POST', '/admin/imports/products/preview', { token: st.catalog.token, body: { csv: csv.split('\r\n').slice(0, 3).join('\n').replace('150000,90000,5', '160000,90000,0') } });
    expect(pv2.json.changes).toEqual({ update_price: 1, no_change: 1 });
    await api(tt, 'POST', `/admin/imports/${pv2.json.batch_id}/commit`, { token: st.catalog.token });
    expect((await tt.db.query(`SELECT COUNT(*)::int n FROM skus WHERE sku_code LIKE $1`, [`IMP-${sfx}-%`])).rows[0].n).toBe(2);
    expect((await api(tt, 'POST', '/admin/imports/products/preview', { token: (await mkUser(tt, ['partner'])).token, body: { csv } })).status).toBe(403);
  });
});

describe('T030 — media upload validation', () => {
  it('accepts real images (re-encoded WEBP variants), rejects SVG/HTML/executable/oversize/tiny/renamed files', async () => {
    const tt = await setupApp();
    const st = await staff(tt);
    const { mkProduct } = await import('./helpers.js');
    const p = await mkProduct(tt, {});
    const sharp = (await import('sharp')).default;
    const png = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#2a6' } }).png().toBuffer();
    const up = (buf: Buffer, filename: string) => api(tt, 'POST', `/admin/products/${p.productId}/media`, { token: st.catalog.token, body: { filename, content_base64: buf.toString('base64'), alt: { 'uz-Latn': 'Rasm' }, rights_source: 'own photo' } });
    const ok = await up(png, '../../etc/passwd.png');
    expect(ok.status).toBe(200);
    expect(Object.keys(ok.json.variants)).toEqual(['w320', 'w640', 'w1200']);
    const img = await api(tt, 'GET', `/media/${ok.json.variants.w320}`);
    expect(img.status).toBe(200);
    expect(img.raw.headers['content-type']).toBe('image/webp');
    expect((await sharp(img.raw.rawPayload).metadata()).width).toBe(320);
    expect((await up(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'x.png')).json.code).toBe('MEDIA_TYPE_NOT_ALLOWED');
    expect((await up(Buffer.from('<html><script>alert(1)</script></html>'), 'x.jpg')).json.code).toBe('MEDIA_TYPE_NOT_ALLOWED');
    expect((await up(Buffer.from('MZ\x90\x00executable'), 'x.webp')).json.code).toBe('MEDIA_TYPE_NOT_ALLOWED');
    const tiny = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#000' } }).jpeg().toBuffer();
    expect((await up(tiny, 'tiny.jpg')).json.code).toBe('MEDIA_DIMENSIONS_INVALID');
    expect((await up(Buffer.concat([png.subarray(0, 40), Buffer.alloc(100)]), 'broken.png')).json.code).toBe('MEDIA_CORRUPT');
    expect((await api(tt, 'GET', '/media/..%2F..%2Fetc%2Fpasswd')).status).toBe(404);
    const pub = await api(tt, 'GET', `/products/${p.slug}`);
    expect(pub.json.media[0].url).toContain('-w640.webp');
  });
});
