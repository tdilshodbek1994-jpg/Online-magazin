import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type MetaAdsAdapter, type RemoteIds, setMetaAdapter } from '../src/modules/target/adapter.js';
import { api, mkProduct, mkUser, setupIsolatedApp, staff, type Staff, type T } from './helpers.js';

/** UZSHOP Landing & Target — P1B (LT-061…LT-070) with a fake Meta adapter; live spend stays off by default. */
let t: T;
let s: Staff;
const fake = {
  scopes: ['ads_read', 'ads_management'] as string[], pages: ['111222333'] as string[], creates: 0, activates: 0, timeoutNext: false,
  byRef: new Map<string, RemoteIds>(), statusOut: { configured: 'PAUSED', effective: 'PAUSED', review_feedback: null as string | null },
};
const adapter: MetaAdsAdapter = {
  name: 'fake',
  authorizeUrl: (state) => `https://meta.test/oauth?state=${encodeURIComponent(state)}`,
  exchangeCode: async () => ({ token: 'secret-token-123', expires_at: null, scopes: fake.scopes, business_id: 'b1' }),
  verifyAssets: async (_t, w) => ({ ad_account: w.ad_account_id === 'act_1001' ? { id: 'act_1001', currency: 'UZS', timezone: 'Asia/Tashkent' } : null, page: w.page_id && fake.pages.includes(w.page_id) ? w.page_id : null, dataset: w.dataset_id === '123456789012' ? w.dataset_id : null }),
  createPaused: async (_t, req) => {
    fake.creates++;
    const n = fake.creates;
    const ids = { campaign_id: `c${n}`, adset_id: `s${n}`, creative_id: `cr${n}`, ad_id: `a${n}` };
    fake.byRef.set(req.client_ref, ids);
    if (fake.timeoutNext) { fake.timeoutNext = false; throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' }); } // created remotely, answer lost
    return ids;
  },
  findByClientRef: async (_t, _a, ref) => fake.byRef.get(ref) ?? null,
  activate: async () => { fake.activates++; await new Promise((r) => setTimeout(r, 30)); },
  pause: async () => undefined,
  status: async () => fake.statusOut,
};
let landing: any;
beforeAll(async () => {
  t = await setupIsolatedApp('om_test_target');
  s = await staff(t);
  setMetaAdapter(adapter);
  const prod = await mkProduct(t, { prices: [100_000], stock: [10] });
  const c = await api(t, 'POST', '/admin/landings', { token: s.owner.token, body: { slug: `tg-${randomUUID().slice(0, 8)}`, title: 'Target', template: 'pro', product_ids: [prod.productId] } });
  for (const st of ['submit', 'approve', 'publish']) await api(t, 'POST', `/admin/landings/${c.json.id}/${st}`, { token: s.owner.token, body: {} });
  landing = (await api(t, 'GET', `/admin/landings/${c.json.id}`, { token: s.owner.token })).json;
  await t.db.query(`UPDATE tracking_settings SET dataset_id='123456789012' WHERE id=1`);
});
afterAll(() => setMetaAdapter(null));
beforeEach(async () => {
  fake.scopes = ['ads_read', 'ads_management']; fake.pages = ['111222333']; fake.timeoutNext = false;
  await t.db.query(`UPDATE feature_flags SET enabled=false WHERE key='ads.live_spend'`);
});

async function connect(token = s.owner.token) {
  const st = await api(t, 'POST', '/admin/meta/oauth/start', { token });
  expect(st.status).toBe(200);
  const state = decodeURIComponent(new URL(st.json.authorize_url).searchParams.get('state')!);
  const cb = await api(t, 'POST', '/admin/meta/oauth/callback', { token, body: { state, code: 'code-1234' } });
  expect(cb.json.status).toBe('connected');
  return state;
}
async function bindAssets(page = '111222333') {
  return api(t, 'POST', '/admin/meta/assets', { token: s.owner.token, body: { ad_account_id: 'act_1001', page_id: page, dataset_id: '123456789012' } });
}
async function draft(edit: Record<string, unknown> = {}) {
  const c = await api(t, 'POST', '/admin/ad-campaigns', { token: s.owner.token, body: { landing_id: landing.id } });
  expect(c.status).toBe(200);
  const d = (await api(t, 'GET', `/admin/ad-campaigns/${c.json.id}`, { token: s.owner.token })).json;
  const start = new Date(Date.now() + 86_400_000).toISOString();
  const end = new Date(Date.now() + 8 * 86_400_000).toISOString();
  const u = await api(t, 'PUT', `/admin/ad-campaigns/${d.id}`, { token: s.owner.token, body: { expected_version: d.version, budget_minor: '10000000', payer_label: 'UzShop karta ****1234', start_at: start, end_at: end, ...edit } });
  expect(u.status).toBe(200);
  return d.id as string;
}
const get = async (id: string) => (await api(t, 'GET', `/admin/ad-campaigns/${id}`, { token: s.owner.token })).json;
async function approved(id: string) {
  const pf = await api(t, 'POST', `/admin/ad-campaigns/${id}/preflight`, { token: s.owner.token });
  expect(pf.json.ok, JSON.stringify(pf.json.checks.filter((c: any) => !c.ok))).toBe(true);
  expect((await api(t, 'POST', `/admin/ad-campaigns/${id}/approve`, { token: s.owner.token, body: { digest: pf.json.digest } })).status).toBe(200);
}

describe('AI Target P1B', () => {
  it('without a Meta app or connection everything is honestly blocked (no fake success)', async () => {
    setMetaAdapter(null);
    expect((await api(t, 'POST', '/admin/meta/oauth/start', { token: s.owner.token })).json.code).toBe('META_APP_NOT_CONFIGURED');
    const id = await draft();
    const pf = await api(t, 'POST', `/admin/ad-campaigns/${id}/preflight`, { token: s.owner.token });
    expect(pf.json.ok).toBe(false);
    expect(pf.json.checks.find((c: any) => c.check === 'meta_connection').reason).toBe('meta_not_connected');
    expect((await get(id)).status).toBe('preflight_failed');
    setMetaAdapter(adapter);
  });

  it('LT-061: a foreign, replayed or other-session OAuth state never connects an account', async () => {
    expect((await api(t, 'POST', '/admin/meta/oauth/callback', { token: s.owner.token, body: { state: 'x'.repeat(32), code: 'code-1234' } })).json.code).toBe('OAUTH_STATE_INVALID');
    const st = await api(t, 'POST', '/admin/meta/oauth/start', { token: s.owner.token });
    const state = decodeURIComponent(new URL(st.json.authorize_url).searchParams.get('state')!);
    const other = await mkUser(t, ['owner']); // another owner session
    expect((await api(t, 'POST', '/admin/meta/oauth/callback', { token: other.token, body: { state, code: 'code-1234' } })).json.code).toBe('OAUTH_STATE_INVALID');
    expect((await api(t, 'POST', '/admin/meta/oauth/callback', { token: s.owner.token, body: { state, code: 'code-1234' } })).json.status).toBe('connected');
    expect((await api(t, 'POST', '/admin/meta/oauth/callback', { token: s.owner.token, body: { state, code: 'code-1234' } })).json.code).toBe('OAUTH_STATE_INVALID'); // single use
    expect((await api(t, 'POST', '/admin/meta/oauth/start', { token: s.catalog.token })).status).toBe(403);
    const conn = await api(t, 'GET', '/admin/meta/connection', { token: s.owner.token });
    expect(JSON.stringify(conn.json)).not.toContain('secret-token');
    expect((await t.db.query(`SELECT token_ciphertext FROM meta_connections WHERE status='connected'`)).rows[0].token_ciphertext).not.toContain('secret-token');
  });

  it('LT-062: read-only scope → reporting yes, manage/provision blocked by permission', async () => {
    fake.scopes = ['ads_read'];
    await connect();
    await bindAssets();
    const conn = (await api(t, 'GET', '/admin/meta/connection', { token: s.owner.token })).json;
    expect(conn.capabilities).toMatchObject({ reporting: true, manage_ads: false, live_spend_flag: false });
    const id = await draft();
    const pf = await api(t, 'POST', `/admin/ad-campaigns/${id}/preflight`, { token: s.owner.token });
    expect(pf.json.checks.find((c: any) => c.check === 'meta_connection').reason).toBe('permission_missing:ads_management');
    expect((await api(t, 'POST', `/admin/ad-campaigns/${id}/provision`, { token: s.owner.token })).status).toBe(409);
  });

  it('LT-063: Page not confirmed by the provider → asset binding blocker, no launch', async () => {
    await connect();
    fake.pages = [];
    const a = await bindAssets('999888777');
    expect(a.json.not_confirmed).toContain('page_id');
    const id = await draft({ page_id: '999888777' });
    const pf = await api(t, 'POST', `/admin/ad-campaigns/${id}/preflight`, { token: s.owner.token });
    expect(pf.json.checks.find((c: any) => c.check === 'page_verified')).toMatchObject({ ok: false, reason: 'asset_not_verified:page' });
    expect(pf.json.digest).toBeNull();
    expect((await api(t, 'POST', `/admin/ad-campaigns/${id}/provision`, { token: s.owner.token })).json.code).toBe('APPROVAL_REQUIRED');
  });

  it('LT-064: approved draft → remote objects created PAUSED; "created" is not "delivering"; activation refused while live spend is off', async () => {
    await connect(); await bindAssets();
    const id = await draft();
    await approved(id);
    const before = fake.creates;
    const p = await api(t, 'POST', `/admin/ad-campaigns/${id}/provision`, { token: s.owner.token });
    expect(p.json.status).toBe('provisioned_paused');
    expect(fake.creates).toBe(before + 1);
    const d = await get(id);
    expect(d).toMatchObject({ status: 'provisioned_paused', configured_status: 'PAUSED' });
    expect(d.remote.every((r: any) => r.configured_status === 'PAUSED')).toBe(true);
    expect((await api(t, 'POST', `/admin/ad-campaigns/${id}/provision`, { token: s.owner.token })).json.replayed).toBe(true);
    expect(fake.creates).toBe(before + 1);
    expect((await api(t, 'POST', `/admin/ad-campaigns/${id}/activate`, { token: s.owner.token })).json.code).toBe('LIVE_SPEND_DISABLED');
    expect((await api(t, 'POST', `/admin/ad-campaigns/${id}/approve`, { token: s.catalog.token, body: { digest: 'a'.repeat(64) } })).status).toBe(403);
  });

  it('LT-065 + LT-066 + LT-067: creative revision, budget +1 or a longer schedule invalidate the approval; expired approval too', async () => {
    await connect(); await bindAssets();
    for (const change of [
      (d: any) => ({ creative: { headline: 'Yangi sarlavha', primary_text: 'Yangi matn', cta: 'ORDER_NOW' } }),
      (_d: any) => ({ budget_minor: '10000100' }),
      (d: any) => ({ end_at: new Date(Date.parse(d.end_at) + 86_400_000).toISOString() }),
    ]) {
      const id = await draft();
      await approved(id);
      const d = await get(id);
      const rev = d.creative_revision;
      expect((await api(t, 'PUT', `/admin/ad-campaigns/${id}`, { token: s.owner.token, body: { expected_version: d.version, ...change(d) } })).status).toBe(200);
      const after = await get(id);
      expect(after.approval).toEqual({ valid: false, reason: 'approval_stale' });
      if ('creative' in change(d)) expect(after.creative_revision).toBe(rev + 1);
      expect((await api(t, 'POST', `/admin/ad-campaigns/${id}/provision`, { token: s.owner.token })).json.code).toBe('APPROVAL_REQUIRED');
      await approved(id); // a fresh approval of the new scope works
      expect((await get(id)).approval.valid).toBe(true);
    }
    const id = await draft();
    await approved(id);
    await t.db.query(`UPDATE campaign_approvals SET expires_at = now() - interval '1 minute' WHERE draft_id=$1`, [id]);
    expect((await api(t, 'POST', `/admin/ad-campaigns/${id}/provision`, { token: s.owner.token })).json.code).toBe('APPROVAL_EXPIRED');
  });

  it('LT-068: two activation requests → one internal operation, one provider call', async () => {
    await connect(); await bindAssets();
    const id = await draft();
    await approved(id);
    await api(t, 'POST', `/admin/ad-campaigns/${id}/provision`, { token: s.owner.token });
    await t.db.query(`UPDATE feature_flags SET enabled=true WHERE key='ads.live_spend'`);
    const before = fake.activates;
    const [a, b] = await Promise.all([1, 2].map(() => api(t, 'POST', `/admin/ad-campaigns/${id}/activate`, { token: s.owner.token })));
    expect([a!.status, b!.status]).toEqual([200, 200]);
    expect(fake.activates).toBe(before + 1);
    expect((await t.db.query(`SELECT COUNT(*)::int n FROM provisioning_operations WHERE draft_id=$1 AND kind='activate'`, [id])).rows[0].n).toBe(1);
    expect((await get(id)).status).toBe('delivery_pending');
  });

  it('LT-069: create timeout → unknown; the retry reconciles by client reference instead of creating again', async () => {
    await connect(); await bindAssets();
    const id = await draft();
    await approved(id);
    fake.timeoutNext = true;
    const before = fake.creates;
    expect((await api(t, 'POST', `/admin/ad-campaigns/${id}/provision`, { token: s.owner.token })).json.status).toBe('unknown');
    expect((await get(id)).status).toBe('unknown');
    const r = await api(t, 'POST', `/admin/ad-campaigns/${id}/provision`, { token: s.owner.token });
    expect(r.json.status).toBe('provisioned_paused');
    expect(fake.creates).toBe(before + 1); // no blind second create
    expect(r.json.remote.campaign_id).toBe(`c${before + 1}`);
  });

  it('LT-070: configured ACTIVE but moderation pending → delivery pending, not "running"; rejection reason kept', async () => {
    await connect(); await bindAssets();
    const id = await draft();
    await approved(id);
    await api(t, 'POST', `/admin/ad-campaigns/${id}/provision`, { token: s.owner.token });
    await t.db.query(`UPDATE feature_flags SET enabled=true WHERE key='ads.live_spend'`);
    await api(t, 'POST', `/admin/ad-campaigns/${id}/activate`, { token: s.owner.token });
    fake.statusOut = { configured: 'ACTIVE', effective: 'PENDING_REVIEW', review_feedback: null };
    expect((await api(t, 'POST', `/admin/ad-campaigns/${id}/sync`, { token: s.owner.token })).json).toMatchObject({ status: 'delivery_pending', configured_status: 'ACTIVE', effective_status: 'PENDING_REVIEW' });
    fake.statusOut = { configured: 'ACTIVE', effective: 'DISAPPROVED', review_feedback: 'Ad text policy' };
    expect((await api(t, 'POST', `/admin/ad-campaigns/${id}/sync`, { token: s.owner.token })).json).toMatchObject({ status: 'rejected', review_feedback: 'Ad text policy' });
    fake.statusOut = { configured: 'PAUSED', effective: 'PAUSED', review_feedback: null };
  });

  it('draft copy comes from approved facts; risky claims, links, phones and minors are refused', async () => {
    await connect(); await bindAssets();
    const id = await draft();
    const d = await get(id);
    expect(d.creative.headline.length).toBeGreaterThan(1);
    expect(d.creative.primary_text).toMatch(/Narxi: 100 000 so‘m/);
    expect((await api(t, 'PUT', `/admin/ad-campaigns/${id}`, { token: s.owner.token, body: { expected_version: d.version, audience: { geo: ['UZ'], age_min: 13, age_max: 30 } } })).status).toBe(400);
    expect((await api(t, 'PUT', `/admin/ad-campaigns/${id}`, { token: s.owner.token, body: { expected_version: d.version, audience: { geo: ['UZ'], age_min: 18, age_max: 30, interests: ['religion'] } } })).status).toBe(400);
    const u = await api(t, 'PUT', `/admin/ad-campaigns/${id}`, { token: s.owner.token, body: { expected_version: d.version, creative: { headline: 'Bosh og‘rig‘ini davolaydi', primary_text: 'Qo‘ng‘iroq: +998 90 123 45 67', cta: 'ORDER_NOW' } } });
    expect(u.status).toBe(200);
    const pf = await api(t, 'POST', `/admin/ad-campaigns/${id}/preflight`, { token: s.owner.token });
    expect(pf.json.checks.find((c: any) => c.check === 'creative_policy').ok).toBe(false);
  });
});
