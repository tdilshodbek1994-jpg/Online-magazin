'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errText } from '@/lib/errors';
import { toast } from '@/lib/toast';

const CP: Record<string, string> = { available: 'tayyor', armed: 'faollashtirilgan', reserved: 'buyurtmada', used: 'ishlatilgan', void: 'faol emas' };

/** Admin «🎖️ Darajalar»: level table (names, thresholds, badges, colours, gift discounts), 50% products, disputes, promos, coupons. */
export function LevelsAdmin() {
  const [d, setD] = useState<any>(null);
  const [defs, setDefs] = useState<any[]>([]);
  const [reason, setReason] = useState('');
  const [prods, setProds] = useState<any[]>([]);
  const [partners, setPartners] = useState<any[]>([]);
  const [adj, setAdj] = useState({ partner_id: '', units: '', reason: '' });
  const [promo, setPromo] = useState({ name: '', min_level: '10', pct: '5', days: '7' });
  const load = useCallback(() => { api('/admin/levels').then((x) => { setD(x); setDefs(x.defs.map((z: any) => ({ ...z }))); }).catch((e) => toast(errText(e), 'err')); }, []);
  useEffect(() => { load(); api('/admin/products').then((r) => setProds((r.items ?? []).filter((p: any) => p.status === 'published').slice(0, 300))).catch(() => {}); api('/admin/partners').then((r) => setPartners(r.items ?? [])).catch(() => {}); }, [load]);
  if (!d) return null;
  const run = async (fn: () => Promise<any>, ok: string) => { try { await fn(); toast(ok); load(); } catch (e: any) { toast(e.code === 'OWNER_APPROVAL_REQUIRED' ? 'Faqat egasi.' : e.code === 'THRESHOLDS_MUST_INCREASE' ? 'Chegaralar o‘sib borishi kerak.' : errText(e), 'err'); } };
  const set = (i: number, k: string, v: any) => setDefs(defs.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const enabled = new Set(d.benefit_products.filter((b: any) => b.enabled).map((b: any) => b.product_id));
  return (
    <section style={{ marginTop: 12 }} className="cc">
      <h2>🎖️ Hamkor darajalari</h2>
      <p className="muted small">Daraja faqat yetkazilgan va hisob-kitobi tasdiqlangan donalardan hisoblanadi. {d.constants.coupon_units} ta sotuvda bir martalik 50% kupon, {d.constants.vip_units} tada 50% VIP. Sovg‘a chegirmalari — demo qiymatlar, egasi tasdiqlaydi.</p>
      <details className="card pp-more"><summary>Darajalar jadvali</summary>
        <div style={{ overflowX: 'auto' }}><table className="tr-table" style={{ minWidth: 520 }}><tbody><tr><th>#</th><th>Nomi</th><th>Chegara</th><th>Nishon</th><th>Rang</th><th>Chegirma %</th></tr>
          {defs.map((x, i) => <tr key={x.level}><td>{x.level}</td>
            <td><input aria-label={`Nom ${x.level}`} value={x.name} onChange={(e) => set(i, 'name', e.target.value)} /></td>
            <td><input aria-label={`Chegara ${x.level}`} inputMode="numeric" value={x.threshold} onChange={(e) => set(i, 'threshold', Number(e.target.value.replace(/\D/g, '')) || 0)} /></td>
            <td><input aria-label={`Nishon ${x.level}`} value={x.badge} maxLength={8} onChange={(e) => set(i, 'badge', e.target.value)} style={{ width: 52 }} /></td>
            <td><input aria-label={`Rang ${x.level}`} type="color" value={x.color} onChange={(e) => set(i, 'color', e.target.value)} /></td>
            <td><input aria-label={`Chegirma ${x.level}`} inputMode="decimal" value={x.gift_discount_bps / 100} onChange={(e) => set(i, 'gift_discount_bps', Math.round(Number(e.target.value) * 100) || 0)} style={{ width: 64 }} /></td></tr>)}
        </tbody></table></div>
        <input aria-label="O‘zgarish sababi" placeholder="O‘zgarish sababi (auditga yoziladi)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <button className="btn sm mt8" disabled={reason.trim().length < 5} onClick={() => run(() => api('/admin/levels', { method: 'PUT', body: { reason, defs: defs.map(({ level, name, threshold, badge, color, gift_discount_bps, perks }) => ({ level, name, threshold, badge, color, gift_discount_bps, perks })) } }), '✓ Saqlandi va hamkorlar qayta hisoblandi')}>Saqlash (egasi)</button>
      </details>
      <details className="card pp-more"><summary>50% imtiyoz qo‘llanadigan mahsulotlar ({enabled.size})</summary>
        <p className="small muted">Har buyurtma qatorida marja tekshiriladi: narx − tannarx − 50% ≥ 0. Tannarx kiritilmagan mahsulotga 50% qo‘llanmaydi.</p>
        <div style={{ maxHeight: 280, overflowY: 'auto' }}>{prods.map((p) => <label key={p.id} className="row small" style={{ gap: 8, alignItems: 'center' }}><input type="checkbox" checked={enabled.has(p.id)} onChange={(e) => run(() => api(`/admin/levels/benefit-products/${p.id}`, { method: 'PUT', body: { enabled: e.target.checked } }), '✓ Saqlandi')} />{p.name?.['uz-Latn'] ?? p.slug}</label>)}</div>
      </details>
      <details className="card pp-more"><summary>Bahsli holat: sotuvlar sonini tuzatish</summary>
        <div className="tr-form">
          <select aria-label="Hamkor" value={adj.partner_id} onChange={(e) => setAdj({ ...adj, partner_id: e.target.value })}><option value="">— hamkor —</option>{partners.map((p: any) => <option key={p.id} value={p.id}>{p.display_name} ({p.code})</option>)}</select>
          <input aria-label="Dona (+/−)" placeholder="+10 yoki −5" value={adj.units} onChange={(e) => setAdj({ ...adj, units: e.target.value.replace(/[^\d-]/g, '') })} />
          <input aria-label="Sabab" placeholder="Sabab (kamida 5 belgi)" value={adj.reason} onChange={(e) => setAdj({ ...adj, reason: e.target.value })} />
          <button className="btn secondary sm" disabled={!adj.partner_id || !Number(adj.units) || adj.reason.trim().length < 5} onClick={() => run(() => api('/admin/levels/adjustments', { method: 'POST', body: { partner_id: adj.partner_id, units: Number(adj.units), reason: adj.reason } }), '✓ Tuzatildi (auditga yozildi)')}>Tuzatish (egasi)</button>
        </div>
        {d.adjustments.map((a: any) => <div key={a.id} className="spread small"><span>{a.display_name}: {a.units > 0 ? '+' : ''}{a.units}</span><span className="muted">{a.reason}</span></div>)}
      </details>
      <details className="card pp-more"><summary>Maxsus aksiya: qo‘shimcha sovg‘a chegirmasi</summary>
        <div className="tr-form">
          <input aria-label="Aksiya nomi" placeholder="Nomi" value={promo.name} onChange={(e) => setPromo({ ...promo, name: e.target.value })} />
          <div className="row" style={{ gap: 8 }}><input aria-label="Qaysi darajadan" inputMode="numeric" value={promo.min_level} onChange={(e) => setPromo({ ...promo, min_level: e.target.value })} /><input aria-label="Qo‘shimcha %" inputMode="decimal" value={promo.pct} onChange={(e) => setPromo({ ...promo, pct: e.target.value })} /><input aria-label="Necha kun" inputMode="numeric" value={promo.days} onChange={(e) => setPromo({ ...promo, days: e.target.value })} /></div>
          <button className="btn secondary sm" disabled={promo.name.length < 2} onClick={() => run(() => api('/admin/levels/promos', { method: 'POST', body: { name: promo.name, min_level: Number(promo.min_level), extra_discount_bps: Math.round(Number(promo.pct) * 100), starts_at: new Date().toISOString(), ends_at: new Date(Date.now() + Number(promo.days) * 86400e3).toISOString() } }), '✓ Aksiya yaratildi')}>Yaratish (egasi)</button>
        </div>
        {d.promos.map((p: any) => <div key={p.id} className="small">{p.name}: {p.min_level}-darajadan +{p.extra_discount_bps / 100}% · {new Date(p.ends_at).toLocaleDateString('uz')} gacha</div>)}
      </details>
      <details className="card pp-more"><summary>Kuponlar va TOP</summary>
        {d.coupons.map((c: any) => <div key={c.id} className="spread small"><span>{c.display_name}</span><span>{CP[c.status]}</span></div>)}
        <table className="tr-table"><tbody>{d.top.map((x: any) => <tr key={x.partner_id}><td>{x.display_name}</td><td>{x.units} dona</td><td>{x.level}-daraja{x.vip_since ? ' · VIP' : ''}</td></tr>)}</tbody></table>
      </details>
    </section>
  );
}
