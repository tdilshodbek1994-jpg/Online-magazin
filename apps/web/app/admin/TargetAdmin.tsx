'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, som } from '@/lib/api';
import { errText } from '@/lib/errors';
import { toast } from '@/lib/toast';

const ST: Record<string, string> = {
  draft: 'Qoralama', preflight_failed: 'Tekshiruvdan o‘tmadi', review: 'Tasdiqqa tayyor', owner_approved: 'Egasi tasdiqladi', provisioning: 'Yaratilmoqda',
  provisioned_paused: 'Meta’da yaratildi (TO‘XTATILGAN)', activation_requested: 'Ishga tushirish so‘raldi', delivery_pending: 'Meta tekshiruvida (hali ko‘rsatilmayapti)',
  delivering: 'Ko‘rsatilmoqda', pause_requested: 'To‘xtatish tasdig‘i kutilmoqda', paused: 'To‘xtatilgan', rejected: 'Meta rad etdi', blocked: 'Bloklangan', completed: 'Tugagan', unknown: 'Natija noma’lum (tekshiriladi)',
};
const WHY: Record<string, string> = {
  meta_not_connected: 'Meta ulanmagan', meta_token_expired: 'Meta kaliti muddati tugagan', 'permission_missing:ads_management': 'Reklama boshqarish ruxsati yo‘q (faqat hisobot)',
  'asset_not_verified:ad_account': 'Reklama hisobi tasdiqlanmagan', 'asset_not_verified:page': 'Sahifa (Page) tasdiqlanmagan', 'asset_not_verified:dataset': 'Dataset tasdiqlanmagan',
  landing_not_published: 'Landing nashrda emas', landing_revision_changed: 'Landing yangi versiyaga o‘tgan', out_of_stock: 'Mahsulot tugagan', dataset_mismatch: 'Dataset Pixel sozlamasidan farq qiladi',
  currency_mismatch: 'Valyuta hisob valyutasiga mos emas', budget_missing: 'Budjet kiritilmagan', schedule_invalid: 'Muddat noto‘g‘ri', creative_missing: 'Reklama matni yo‘q', payer_missing: 'Kim to‘lashi ko‘rsatilmagan',
  adapter_not_connected: 'Meta adapteri ulanmagan', provider_timeout: 'Meta javob bermadi', approval_missing: 'Tasdiq yo‘q', owner_reapproval_required: 'Xavfsizlik to‘xtatgan — qayta yoqish uchun egasi qayta tasdiqlashi kerak', spend_envelope_required: 'Egasi tasdiqlagan umumiy budjet chegarasi yo‘q',
  envelope_exceeded: 'Umumiy budjet chegarasidan oshadi', end_date_required: 'Kunlik budjet uchun tugash sanasi kerak', stock_out: 'Tovar tugadi', landing_unpublished: 'Landing nashrdan olindi', price_changed: 'Narx o‘zgardi', creative_price_mismatch: 'Matndagi narx katalogdan farq qiladi', approval_expired: 'Tasdiq muddati o‘tgan', approval_stale: 'Tasdiqdan keyin o‘zgartirilgan — qayta tasdiq kerak',
};
const CHECK: Record<string, string> = { landing_published: 'Landing nashrda', product_available: 'Mahsulot bor', meta_connection: 'Meta ulanishi va ruxsat', ad_account_verified: 'Reklama hisobi', page_verified: 'Sahifa (Page)',
  dataset_verified: 'Dataset', dataset_matches_tracking: 'Dataset = Pixel sozlamasi', currency_matches_account: 'Valyuta', budget_set: 'Budjet', schedule_valid: 'Muddat', creative_present: 'Reklama matni', creative_price_matches_catalog: 'Matndagi narx = katalog', creative_policy: 'Matn qoidalari', payer_shown: 'To‘lovchi ko‘rsatilgan' };
const why = (r: string | null | undefined) => (r ? r.split(',').map((x) => (x.startsWith('creative_policy') ? 'Matnda taqiqlangan da’vo/havola/telefon bor' : WHY[x] ?? x)).join(' · ') : '');
const local = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() + 5 * 3600_000).toISOString().slice(0, 16) : '');
const toIso = (v: string) => (v ? new Date(`${v}:00+05:00`).toISOString() : null);

/** Admin «🎯 Target»: Meta connection, campaign drafts, preflight, owner approval (digest), PAUSED provisioning. Live spend is off by default. */
export function TargetAdmin() {
  const [conn, setConn] = useState<any>(null);
  const [list, setList] = useState<any[]>([]);
  const [landings, setLandings] = useState<any[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [assets, setAssets] = useState({ ad_account_id: '', page_id: '', dataset_id: '' });
  const load = useCallback(() => {
    api('/admin/meta/connection').then(setConn).catch((e) => toast(errText(e), 'err'));
    api('/admin/ad-campaigns').then((r) => setList(r.items)).catch(() => {});
    api('/admin/landings').then((r) => setLandings(r.items.filter((l: any) => l.status === 'published'))).catch(() => {});
  }, []);
  useEffect(load, [load]);
  const start = async () => {
    try { const r = await api('/admin/meta/oauth/start', { method: 'POST' }); location.href = r.authorize_url; }
    catch (e: any) { toast(e.code === 'META_APP_NOT_CONFIGURED' ? 'Meta ilovasi (App ID) hali sozlanmagan — ulash mumkin emas.' : errText(e), 'err'); }
  };
  return (
    <section style={{ marginTop: 12 }} className="cc">
      <h2>🎯 Target (Meta reklama)</h2>
      <p className="muted small">AI faqat qoralama tayyorlaydi; budjet, auditoriya va ishga tushirishni faqat egasi tasdiqlaydi. Meta’da hamma narsa avval TO‘XTATILGAN holda yaratiladi. Jonli pul sarfi alohida yoqilmaguncha o‘chiq.</p>
      {conn && (
        <div className="card cc-panel">
          <div className="spread"><b>Meta ulanishi</b><span className="pill">{conn.status === 'connected' ? '✅ ulangan' : `⛔ ${why(conn.blocked_reason) || 'ulanmagan'}`}</span></div>
          <p className="small">Hisobot: {conn.capabilities.reporting ? 'bor' : 'yo‘q'} · Reklama boshqarish: {conn.capabilities.manage_ads ? 'bor' : 'yo‘q'} · Jonli sarf: {conn.capabilities.live_spend_flag ? 'YOQILGAN' : 'o‘chiq'}{conn.account_currency ? ` · Valyuta ${conn.account_currency}` : ''}</p>
          {conn.emergency && <p className="notice small">⚠️ {conn.emergency}</p>}
          {!conn.app_configured && <p className="notice small">Meta ilovasi (App ID, API versiyasi) sozlanmagan. Egasi Meta Business’da ilova yaratib, server sozlamasiga kiritgandan keyin ulash mumkin bo‘ladi.</p>}
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="btn sm" onClick={start}>Meta’ni ulash (egasi)</button>
            {conn.status === 'connected' && <button className="btn secondary sm danger-t" onClick={async () => { const r = await api('/admin/meta/disconnect', { method: 'POST' }).catch((e) => toast(errText(e), 'err')); if (r) toast(r.note); load(); }}>Uzish</button>}
          </div>
          {conn.status === 'connected' && <div className="tr-form">
            <input aria-label="Reklama hisobi" placeholder="act_123…" value={assets.ad_account_id} onChange={(e) => setAssets({ ...assets, ad_account_id: e.target.value.trim() })} />
            <input aria-label="Page ID" placeholder="Page ID" value={assets.page_id} onChange={(e) => setAssets({ ...assets, page_id: e.target.value.replace(/\D/g, '') })} />
            <input aria-label="Dataset ID" placeholder="Dataset (Pixel) ID" value={assets.dataset_id} onChange={(e) => setAssets({ ...assets, dataset_id: e.target.value.replace(/\D/g, '') })} />
            <button className="btn secondary sm" onClick={async () => { try { const r = await api('/admin/meta/assets', { method: 'POST', body: Object.fromEntries(Object.entries(assets).filter(([, v]) => v)) }); toast(r.not_confirmed.length ? `Tasdiqlanmadi: ${r.not_confirmed.join(', ')}` : '✓ Aktivlar tasdiqlandi'); load(); } catch (e) { toast(errText(e), 'err'); } }}>Aktivlarni tekshirish</button>
            <p className="small muted">Tasdiqlangan: {Object.entries(conn.verified_assets).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'hali yo‘q'}</p>
          </div>}
        </div>
      )}
      <details className="card pp-more"><summary>＋ Landingdan kampaniya qoralamasi</summary>
        {landings.length ? landings.map((l) => <button key={l.id} className="chip" onClick={async () => { try { const r = await api('/admin/ad-campaigns', { method: 'POST', body: { landing_id: l.id } }); toast('✓ Qoralama tayyor (mahsulot ma’lumotlaridan)'); setSel(r.id); load(); } catch (e) { toast(errText(e), 'err'); } }}>{l.title}</button>) : <p className="small muted">Nashrdagi landing yo‘q.</p>}
      </details>
      <div className="slist">{list.map((c) => <button key={c.id} type="button" className={`scard cc-card ${sel === c.id ? 'sel' : ''}`} onClick={() => setSel(sel === c.id ? null : c.id)}><div className="spread"><b>{c.title}</b><span className="pill">{ST[c.status] ?? c.status}</span></div><div className="small muted">/l/{c.slug} · {c.budget_type === 'daily' ? 'kunlik' : 'umumiy'} {som(c.budget_minor)}{c.blocked_reason ? ` · ${why(c.blocked_reason)}` : ''}</div></button>)}</div>
      {sel && <CampaignEditor id={sel} onChanged={load} />}
      <SafetyPanel />
    </section>
  );
}

function CampaignEditor({ id, onChanged }: { id: string; onChanged: () => void }) {
  const [d, setD] = useState<any>(null);
  const [f, setF] = useState<any>(null);
  const [pf, setPf] = useState<any>(null);
  const load = useCallback(() => { api(`/admin/ad-campaigns/${id}`).then((x) => { setD(x); setPf(x.preflight); setF({ title: x.title, budget: String(BigInt(x.budget_minor) / 100n), budget_type: x.budget_type, payer_label: x.payer_label ?? '', start: local(x.start_at), end: local(x.end_at), headline: x.creative.headline ?? '', primary_text: x.creative.primary_text ?? '', age_min: x.audience.age_min, age_max: x.audience.age_max }); }).catch((e) => toast(errText(e), 'err')); }, [id]);
  useEffect(load, [load]);
  if (!d || !f) return <div className="loading" role="status"><span className="spinner" aria-hidden />…</div>;
  const editable = ['draft', 'preflight_failed', 'review', 'owner_approved', 'blocked'].includes(d.status);
  const act = async (path: string, body?: any, ok = '✓ Bajarildi') => {
    try { const r = await api(`/admin/ad-campaigns/${id}/${path}`, { method: 'POST', body }); toast(r.status === 'blocked' ? `Bloklandi: ${why(r.blocked_reason)}` : r.status === 'unknown' ? 'Natija noma’lum — qayta urinib ko‘ring' : ok); load(); onChanged(); return r; }
    catch (e: any) { toast(e.code === 'LIVE_SPEND_DISABLED' ? 'Jonli pul sarfi o‘chiq (egasi alohida yoqmaguncha).' : e.code === 'OWNER_APPROVAL_REQUIRED' ? 'Faqat egasi.' : WHY[String(e.code).toLowerCase()] ?? errText(e), 'err'); }
  };
  const save = async () => {
    try {
      await api(`/admin/ad-campaigns/${id}`, { method: 'PUT', body: { expected_version: d.version, title: f.title, budget_type: f.budget_type, budget_minor: String(BigInt(f.budget || '0') * 100n), payer_label: f.payer_label || undefined,
        start_at: toIso(f.start) ?? undefined, end_at: toIso(f.end), creative: { headline: f.headline, primary_text: f.primary_text, cta: d.creative.cta ?? 'ORDER_NOW' }, audience: { ...d.audience, age_min: Number(f.age_min), age_max: Number(f.age_max) } } });
      toast('✓ Saqlandi — avvalgi tasdiq (bo‘lsa) eskirdi'); load(); onChanged();
    } catch (e: any) { toast(e.code === 'CAMPAIGN_LOCKED' ? 'Meta’da yaratilgandan keyin tahrirlab bo‘lmaydi.' : errText(e), 'err'); }
  };
  return (
    <div className="card cc-panel">
      <div className="spread"><b>{d.title}</b><span className="pill">{ST[d.status] ?? d.status}</span></div>
      {d.blocked_reason && <p className="notice small">{why(d.blocked_reason)}</p>}
      {d.effective_status && <p className="small">Biz so‘ragan holat: <b>{d.configured_status}</b> · Meta’dagi haqiqiy holat: <b>{d.effective_status}</b>{d.review_feedback ? ` · Sabab: ${d.review_feedback}` : ''}</p>}
      <div className="tr-form">
        <label htmlFor="cp-t">Nomi</label><input id="cp-t" disabled={!editable} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        <label htmlFor="cp-b">Budjet ({d.currency})</label>
        <div className="row" style={{ gap: 8 }}><input id="cp-b" inputMode="numeric" disabled={!editable} value={f.budget} onChange={(e) => setF({ ...f, budget: e.target.value.replace(/\D/g, '').slice(0, 13) })} /><select aria-label="Budjet turi" disabled={!editable} value={f.budget_type} onChange={(e) => setF({ ...f, budget_type: e.target.value })}><option value="daily">kunlik</option><option value="lifetime">umumiy</option></select></div>
        <label htmlFor="cp-p">Kim to‘laydi (karta/hisob)</label><input id="cp-p" disabled={!editable} value={f.payer_label} onChange={(e) => setF({ ...f, payer_label: e.target.value })} placeholder="masalan UzShop karta ****1234" />
        <label htmlFor="cp-s">Boshlanish / tugash (Toshkent)</label>
        <div className="row" style={{ gap: 8 }}><input id="cp-s" type="datetime-local" disabled={!editable} value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /><input aria-label="Tugash" type="datetime-local" disabled={!editable} value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} /></div>
        <label htmlFor="cp-h">Sarlavha</label><input id="cp-h" disabled={!editable} value={f.headline} maxLength={60} onChange={(e) => setF({ ...f, headline: e.target.value })} />
        <label htmlFor="cp-x">Matn</label><textarea id="cp-x" rows={4} disabled={!editable} value={f.primary_text} maxLength={500} onChange={(e) => setF({ ...f, primary_text: e.target.value })} />
        <label htmlFor="cp-a">Yosh (18+)</label>
        <div className="row" style={{ gap: 8 }}><input id="cp-a" type="number" min={18} max={65} disabled={!editable} value={f.age_min} onChange={(e) => setF({ ...f, age_min: e.target.value })} /><input aria-label="Yosh gacha" type="number" min={18} max={65} disabled={!editable} value={f.age_max} onChange={(e) => setF({ ...f, age_max: e.target.value })} /></div>
        {editable && <button className="btn sm" onClick={save}>Saqlash</button>}
      </div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {editable && <button className="btn secondary sm" onClick={async () => { const r = await act('preflight', undefined, '✓ Tekshirildi'); if (r) setPf(r); }}>Tekshirish (preflight)</button>}
        {['review', 'paused'].includes(d.status) && !d.approval.valid && <button className="btn sm" onClick={() => act('approve', { digest: d.digest }, '✓ Tasdiqlandi')}>Tasdiqlash: {som(d.budget_minor)} {d.budget_type === 'daily' ? 'kuniga' : 'jami'}, to‘lovchi {d.payer_label} (egasi)</button>}
        {['owner_approved', 'unknown', 'blocked'].includes(d.status) && d.approval.valid && <button className="btn secondary sm" onClick={() => act('provision', undefined, '✓ Meta’da TO‘XTATILGAN holda yaratildi')}>Meta’da to‘xtatilgan holda yaratish (egasi)</button>}
        {['provisioned_paused', 'paused'].includes(d.status) && <button className="btn secondary sm" onClick={() => act('activate', undefined, 'Ishga tushirish so‘raldi — Meta tekshiruvi kutilmoqda')}>Ishga tushirish (pul sarflanadi, egasi)</button>}
        {d.remote.length > 0 && <button className="btn secondary sm" onClick={() => act('sync', undefined, '✓ Holat yangilandi')}>Holatni yangilash</button>}
        {d.remote.length > 0 && !['paused', 'provisioned_paused'].includes(d.status) && <button className="btn secondary sm danger-t" onClick={() => act('pause')}>To‘xtatish</button>}
      </div>
      <p className="small muted">Tasdiq: {d.approval.valid ? '✅ amalda' : why(d.approval.reason)} · Matn versiyasi v{d.creative_revision} · Landing v{d.landing_revision}</p>
      {pf && <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{pf.checks.map((c: any) => <li key={c.check}>{c.ok ? '✅' : '⛔'} {CHECK[c.check] ?? c.check}{c.ok ? '' : ` — ${why(c.reason)}`}</li>)}</ul>}
    </div>
  );
}

const RULE: Record<string, string> = { stock_out: 'Tovar tugasa — to‘xtatish so‘rovi', landing_unpublished: 'Landing nashrdan olinsa — to‘xtatish so‘rovi', price_changed: 'Narx o‘zgarsa — to‘xtatish so‘rovi' };
/** P2A: protective rules (pause only), spending envelope, master kill switch, automation receipts. */
function SafetyPanel() {
  const [x, setX] = useState<any>(null);
  const [total, setTotal] = useState('');
  const load = useCallback(() => { api('/admin/ad-safety').then(setX).catch(() => {}); }, []);
  useEffect(load, [load]);
  if (!x) return null;
  const env = x.envelopes.find((e: any) => !e.closed_at);
  const run = async (fn: () => Promise<any>, ok: string) => { try { await fn(); toast(ok); load(); } catch (e: any) { toast(e.code === 'OWNER_APPROVAL_REQUIRED' ? 'Faqat egasi.' : errText(e), 'err'); } };
  return (
    <details className="card pp-more" style={{ marginTop: 12 }}>
      <summary>🛡️ Xavfsizlik: chegaralar va favqulodda to‘xtatish</summary>
      <p className="small muted">Avtomatika faqat to‘xtatish so‘rovini yuboradi — hech qachon yoqmaydi va budjetni oshirmaydi. To‘xtatilgandan keyin qayta yoqish faqat egasining yangi tasdig‘i bilan.</p>
      {x.rules.map((r: any) => <label key={r.kind} className="row small" style={{ gap: 8, alignItems: 'center' }}><input type="checkbox" checked={r.enabled} onChange={(e) => run(() => api(`/admin/ad-safety/rules/${r.kind}`, { method: 'PUT', body: { enabled: e.target.checked } }), '✓ Saqlandi')} />{RULE[r.kind] ?? r.kind}</label>)}
      <p className="small">Umumiy budjet chegarasi: {env ? `${som(env.total_minor)} (band: ${som(env.reserved_minor)})` : 'yo‘q — ishga tushirib bo‘lmaydi'}</p>
      <div className="row" style={{ gap: 8 }}><input aria-label="Chegara (so‘m)" inputMode="numeric" placeholder="Chegara, so‘m" value={total} onChange={(e) => setTotal(e.target.value.replace(/\D/g, '').slice(0, 13))} />
        <button className="btn secondary sm" disabled={!total} onClick={() => run(() => api('/admin/ad-safety/envelopes', { method: 'POST', body: { currency: 'UZS', total_minor: String(BigInt(total) * 100n) } }), '✓ Chegara tasdiqlandi')}>Tasdiqlash (egasi)</button></div>
      <button className="btn sm danger-t" style={{ marginTop: 8 }} onClick={() => { if (confirm('UzShop yaratgan barcha reklamalarga to‘xtatish so‘rovi yuborilsinmi?')) void run(() => api('/admin/ad-safety/kill-switch', { method: 'POST', body: { reason: 'admin favqulodda to‘xtatish' } }), 'To‘xtatish so‘rovlari yuborildi'); }}>⛔ Hammasini to‘xtatish (faqat UzShop kampaniyalari)</button>
      {x.receipts.length > 0 && <table className="tr-table" style={{ marginTop: 8 }}><tbody>{x.receipts.map((r: any) => <tr key={r.id}><td>{new Date(r.created_at).toLocaleString('uz')}</td><td>{r.title ?? '—'}</td><td>{r.action === 'pause_requested' ? 'To‘xtatish so‘raldi' : r.action === 'pause_failed' ? 'Meta javob bermadi' : r.action === 'kill_switch' ? 'Favqulodda' : r.action}</td><td className="muted">{why(r.reason) || r.reason}</td></tr>)}</tbody></table>}
    </details>
  );
}
