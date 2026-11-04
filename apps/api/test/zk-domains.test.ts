import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setTxtResolver, signFlowToken } from '../src/modules/landings/domains.js';
import { api, mkProduct, setupIsolatedApp, staff, type Staff, type T } from './helpers.js';

/** UZSHOP Landing & Target — P2B custom domains (LT-031…LT-040) on a separate database; DNS is simulated. */
let t: T;
let s: Staff;
const dns = new Map<string, string[][]>();
beforeAll(async () => {
  t = await setupIsolatedApp('om_test_domains');
  s = await staff(t);
  setTxtResolver(async (name) => { const r = dns.get(name); if (!r) throw Object.assign(new Error('nf'), { code: 'ENOTFOUND' }); return r; });
});
afterAll(() => setTxtResolver(null));
async function landing() {
  const prod = await mkProduct(t, { prices: [100_000], stock: [5] });
  const c = await api(t, 'POST', '/admin/landings', { token: s.owner.token, body: { slug: `d-${randomUUID().slice(0, 8)}`, title: 'Domain', template: 'pro', product_ids: [prod.productId] } });
  for (const st of ['submit', 'approve', 'publish']) await api(t, 'POST', `/admin/landings/${c.json.id}/${st}`, { token: s.owner.token, body: {} });
  return (await api(t, 'GET', `/admin/landings/${c.json.id}`, { token: s.owner.token })).json;
}
const host = () => `shop-${randomUUID().slice(0, 6)}.example.uz`;
async function claim(h: string, landingId: string) {
  const r = await api(t, 'POST', '/admin/domains', { token: s.owner.token, body: { host: h, landing_id: landingId } });
  expect(r.status).toBe(200);
  return r.json;
}
async function verified(h: string, landingId: string) {
  const c = await claim(h, landingId);
  dns.set(c.dns_record.name, [[c.dns_record.value]]);
  expect((await api(t, 'POST', `/admin/domains/${c.id}/verify`, { token: s.owner.token })).json.status).toBe('verified');
  return c;
}

describe('Custom domains P2B', () => {
  it('LT-031 + LT-033: without TXT proof the domain stays pending (CNAME/other records are not ownership); unverified host is not served', async () => {
    const l = await landing();
    const h = host();
    const c = await claim(h, l.id);
    expect(c.status).toBe('pending');
    expect(c.dns_record).toMatchObject({ type: 'TXT', name: `_uzshop-verify.${h}` });
    expect((await api(t, 'POST', `/admin/domains/${c.id}/verify`, { token: s.owner.token })).json).toMatchObject({ status: 'pending', result: 'dns_error:ENOTFOUND' });
    dns.set(c.dns_record.name, [['v=spf1 -all'], ['cname-target=uzshop.uz']]);
    expect((await api(t, 'POST', `/admin/domains/${c.id}/verify`, { token: s.owner.token })).json).toMatchObject({ status: 'pending', result: 'txt_not_found' });
    expect((await api(t, 'GET', `/hosts/resolve?host=${h}`)).json.code).toBe('HOST_UNKNOWN');
    dns.set(c.dns_record.name, [[c.dns_record.value]]);
    expect((await api(t, 'POST', `/admin/domains/${c.id}/verify`, { token: s.owner.token })).json.status).toBe('verified');
    expect((await api(t, 'GET', `/hosts/resolve?host=${h}`)).json.slug).toBe(l.slug);
  });

  it('LT-032: a host already claimed cannot be claimed again; the original mapping stays', async () => {
    const l1 = await landing(), l2 = await landing();
    const h = host();
    await verified(h, l1.id);
    expect((await api(t, 'POST', '/admin/domains', { token: s.owner.token, body: { host: h, landing_id: l2.id } })).json.code).toBe('DOMAIN_TAKEN');
    expect((await api(t, 'GET', `/hosts/resolve?host=${h}`)).json.slug).toBe(l1.slug);
    expect((await api(t, 'POST', '/admin/domains', { token: s.catalog.token, body: { host: host(), landing_id: l2.id } })).status).toBe(403);
  });

  it('LT-034 + LT-035: TLS and Meta are separate statuses; Meta field accepts only the token (no script)', async () => {
    const l = await landing();
    const c = await verified(host(), l.id);
    const r = await api(t, 'PUT', `/admin/domains/${c.id}`, { token: s.owner.token, body: { tls_status: 'ready' } });
    expect(r.json).toMatchObject({ status: 'verified', tls_status: 'ready', meta_status: 'unknown' });
    expect(r.json.success).toBeUndefined();
    for (const bad of ['<script>alert(1)</script>', '<meta name="facebook-domain-verification" content="abc"><script>x</script>', 'javascript:alert(1)'])
      expect((await api(t, 'PUT', `/admin/domains/${c.id}`, { token: s.owner.token, body: { meta_verification: bad } })).json.code).toBe('META_TOKEN_INVALID');
    const ok = await api(t, 'PUT', `/admin/domains/${c.id}`, { token: s.owner.token, body: { meta_verification: '<meta name="facebook-domain-verification" content="abcdefghij0123456789xyz" />' } });
    expect(ok.json.meta_status).toBe('token_saved');
    expect((await t.db.query(`SELECT meta_token FROM landing_domains WHERE id=$1`, [c.id])).rows[0].meta_token).toBe('abcdefghij0123456789xyz');
  });

  it('LT-036: an unknown Host gets a safe rejection, never another tenant’s landing', async () => {
    for (const h of ['evil.example.com', 'localhost.localdomain.uz']) expect((await api(t, 'GET', `/hosts/resolve?host=${h}`)).json.code).toBe('HOST_UNKNOWN');
    expect((await api(t, 'GET', `/hosts/resolve?host=${encodeURIComponent('a.b/../admin')}`)).status).toBe(400);
  });

  it('LT-037: an admin session used from a custom landing host has no staff rights', async () => {
    const l = await landing();
    const h = host();
    await verified(h, l.id);
    expect((await api(t, 'GET', '/admin/domains', { token: s.owner.token })).status).toBe(200);
    const fromCustom = await api(t, 'GET', '/admin/domains', { token: s.owner.token, headers: { origin: `https://${h}` } });
    expect(fromCustom.status).not.toBe(200);
    expect([401, 403]).toContain(fromCustom.status);
  });

  it('LT-038: cross-domain handoff uses a short-lived signed token with ids only; tampered/expired → rejected', async () => {
    const l = await landing();
    const h = host();
    await verified(h, l.id);
    const tok = (await api(t, 'POST', '/hosts/flow-token', { body: { host: h } })).json.token as string;
    expect(Object.keys(JSON.parse(Buffer.from(tok.split('.')[0]!, 'base64url').toString())).sort()).toEqual(['e', 'f', 'l']); // no phone/email/customer
    expect((await api(t, 'POST', '/hosts/flow-token/verify', { body: { token: tok } })).json).toEqual({ flow_id: null, landing_id: l.id });
    const tampered = tok.slice(0, -2) + (tok.endsWith('A') ? 'BB' : 'AA');
    expect((await api(t, 'POST', '/hosts/flow-token/verify', { body: { token: tampered } })).json.code).toBe('FLOW_TOKEN_INVALID');
    const expired = signFlowToken(`flow:${t.cfg.mfaKey}`, { flow_id: null, landing_id: l.id, ttlSec: -5 });
    expect((await api(t, 'POST', '/hosts/flow-token/verify', { body: { token: expired } })).json.code).toBe('FLOW_TOKEN_INVALID');
    expect((await api(t, 'POST', '/hosts/flow-token', { body: { host: 'unknown.example.uz' } })).json.code).toBe('HOST_UNKNOWN');
  });

  it('LT-039: fallback A→B then B→A is refused as a redirect loop', async () => {
    const l = await landing();
    const a = await verified(host(), l.id), b = await verified(host(), l.id);
    expect((await api(t, 'PUT', `/admin/domains/${a.id}`, { token: s.owner.token, body: { fallback_domain_id: b.id } })).status).toBe(200);
    expect((await api(t, 'PUT', `/admin/domains/${b.id}`, { token: s.owner.token, body: { fallback_domain_id: a.id } })).json.code).toBe('REDIRECT_LOOP');
    expect((await api(t, 'PUT', `/admin/domains/${a.id}`, { token: s.owner.token, body: { fallback_domain_id: a.id } })).json.code).toBe('REDIRECT_LOOP');
  });

  it('LT-040: disconnecting a domain with a running campaign lists dependencies; pause is requested, not claimed done', async () => {
    const l = await landing();
    const c = await verified(host(), l.id);
    const d = (await t.db.query(`INSERT INTO campaign_drafts (landing_id, landing_revision, title, status, created_by) VALUES ($1,1,'Jonli kampaniya','delivering',$2) RETURNING id`, [l.id, s.owner.id])).rows[0].id;
    for (const lv of ['campaign', 'adset', 'creative', 'ad']) await t.db.query(`INSERT INTO remote_objects (draft_id, level, remote_id, configured_status) VALUES ($1,$2,$3,'ACTIVE')`, [d, lv, `${lv}-1`]);
    const first = await api(t, 'POST', `/admin/domains/${c.id}/disconnect`, { token: s.owner.token, body: {} });
    expect(first.json).toMatchObject({ disconnected: false });
    expect(first.json.dependencies.map((x: any) => x.id)).toEqual([d]);
    const second = await api(t, 'POST', `/admin/domains/${c.id}/disconnect`, { token: s.owner.token, body: { confirm: true } });
    expect(second.json.disconnected).toBe(true);
    expect((await t.db.query(`SELECT status FROM campaign_drafts WHERE id=$1`, [d])).rows[0].status).toBe('pause_requested'); // provider not connected → still only requested
    expect(second.json.note).toMatch(/hisoblanmaydi/);
  });
});
