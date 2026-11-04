'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, som } from '@/lib/api';
import { errText } from '@/lib/errors';
import { toast } from '@/lib/toast';

const n = (v: string | number) => Number(v).toLocaleString('ru-RU');
const NEXT: Record<string, string> = { created: 'confirmed', confirmed: 'preparing', preparing: 'shipped', shipped: 'delivered' };
const GO_UZ: Record<string, string> = { created: 'Yaratildi', confirmed: 'Tasdiqlandi', preparing: 'Tayyorlanmoqda', shipped: 'Jo‘natildi', delivered: 'Topshirildi', canceled: 'Bekor' };

/** Admin «UzCoin»: liability report, gift catalogue, exchange requests, gift orders, rate (owner). */
export function UzcoinAdmin() {
  const [r, setR] = useState<any>(null);
  const [gifts, setGifts] = useState<any[]>([]);
  const [q, setQ] = useState<any>(null);
  const [g, setG] = useState({ title: '', description: '', price_coins: '', stock: '1', cost: '', delivery_terms: '', image: '' });
  const load = useCallback(() => {
    api('/admin/uzcoin/report').then(setR).catch((e) => toast(errText(e), 'err'));
    api('/admin/uzcoin/gifts').then((x) => setGifts(x.items)).catch(() => {});
    api('/admin/uzcoin/queues').then(setQ).catch(() => {});
  }, []);
  useEffect(load, [load]);
  if (!r) return <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>;
  const call = async (fn: () => Promise<any>, ok = '✓ Saqlandi') => { try { await fn(); toast(ok); load(); } catch (e: any) { toast(errText(e), 'err'); } };
  return (
    <section style={{ marginTop: 12 }} className="cc">
      <h2>🪙 UzCoin boshqaruvi</h2>
      <div className="uzc-grid">
        {[['Chiqarilgan (sotuv)', n(r.issued.sales)], ['Konkurs sovrinlari', n(r.issued.contest)], ['Mavjud balanslar', n(r.balances.available)], ['Band', n(r.balances.reserved)], ['Kutilmoqda (taxmin)', n(r.pending_projection)], ['Sovg‘alarga sarflangan', n(r.balances.spent)],
          ['Pulga almashtirilgan', som(r.exchanges.paid_minor)], ['Sovg‘alar tannarxi', som(r.gifts.cost_minor)], ['Dastur xarajati jami', som(r.total_programme_cost_minor)], ['Kerakli zaxira (majburiyat)', som(r.liability.minor)]].map(([l, v]) => <div key={l}><span>{l}</span><b>{v}</b></div>)}
      </div>
      <p className="small muted">{r.liability.note} Kurs: 1 UzCoin = {som(r.rate.som_per_coin_minor)} (v{r.rate.version}). <button className="link-btn small" onClick={() => { const v = prompt('Yangi kurs (so‘m)'); const reason = v && prompt('Sabab (oldindan e’lon qilingan shart)'); if (v && reason) call(() => api('/admin/uzcoin/rates', { method: 'POST', body: { som_per_coin_minor: Number(v.replace(/\D/g, '')) * 100, reason } }), '✓ Yangi kurs versiyasi'); }}>Kursni o‘zgartirish (egasi)</button></p>

      <h3 className="an-h2">Almashtirish so‘rovlari</h3>
      {q?.exchanges.filter((e: any) => e.status === 'requested').length === 0 && <p className="muted small">Yangi so‘rov yo‘q.</p>}
      {q?.exchanges.filter((e: any) => e.status === 'requested').map((e: any) => (
        <div key={e.id} className="spread small w-prod"><span>{e.display_name} ({e.code}) · {n(e.coins)} coin · {som(e.amount_minor)}</span>
          <span className="row" style={{ gap: 6 }}><button className="btn sm" onClick={() => call(() => api(`/admin/uzcoin/exchanges/${e.id}/approve`, { method: 'POST', body: {} }), '✓ Hamyonga o‘tkazildi')}>Tasdiqlash</button><button className="btn secondary sm" onClick={() => { const reason = prompt('Rad etish sababi') ?? undefined; call(() => api(`/admin/uzcoin/exchanges/${e.id}/reject`, { method: 'POST', body: { reason } }), '✓ Rad etildi, coin qaytdi'); }}>Rad</button></span></div>
      ))}

      <h3 className="an-h2">Sovg‘a buyurtmalari</h3>
      {q?.gift_orders.length === 0 && <p className="muted small">Yo‘q.</p>}
      {q?.gift_orders.map((o: any) => (
        <div key={o.id} className="spread small w-prod"><span>{o.display_name} · {o.gift_title} · 🪙 {n(o.price_coins)} · {GO_UZ[o.status]}</span>
          <span className="row" style={{ gap: 6 }}>{NEXT[o.status] && <button className="btn secondary sm" onClick={() => call(() => api(`/admin/uzcoin/gift-orders/${o.id}/status`, { method: 'POST', body: { status: NEXT[o.status] } }))}>{GO_UZ[NEXT[o.status]!]}</button>}
            {['created', 'confirmed', 'preparing'].includes(o.status) && <button className="link-btn small" onClick={() => { if (confirm('Bekor qilinsinmi? Coin va qoldiq qaytadi.')) call(() => api(`/admin/uzcoin/gift-orders/${o.id}/status`, { method: 'POST', body: { status: 'canceled' } })); }}>Bekor</button>}</span></div>
      ))}

      <h3 className="an-h2">Sovg‘alar katalogi</h3>
      {gifts.map((x) => <div key={x.id} className="spread small w-prod"><span>{x.title} · 🪙 {n(x.price_coins)} · qoldiq {x.stock} · {x.status === 'published' ? 'nashrda' : x.status === 'draft' ? 'qoralama' : 'yashirin'}</span>
        <button className="link-btn small" onClick={() => call(() => api(`/admin/uzcoin/gifts/${x.id}`, { method: 'PUT', body: { ...x, images: x.images ?? [], videos: x.videos ?? [], price_coins: Number(x.price_coins), cost_minor: x.cost_minor === null ? undefined : Number(x.cost_minor), per_partner_limit: x.per_partner_limit ?? undefined, description: x.description ?? undefined, category: x.category ?? undefined, brand: x.brand ?? undefined, variant: x.variant ?? undefined, kit: x.kit ?? undefined, delivery_terms: x.delivery_terms ?? undefined, conditions: x.conditions ?? undefined, status: x.status === 'published' ? 'hidden' : 'published', expected_version: x.version } }))}>{x.status === 'published' ? 'Yashirish' : 'Nashr qilish'}</button></div>)}
      <details className="card pp-more"><summary>＋ Yangi sovg‘a</summary>
        {([['title', 'Nomi'], ['description', 'Tavsif'], ['price_coins', 'UzCoin narxi'], ['stock', 'Qoldiq'], ['cost', 'Haqiqiy tannarx (so‘m)'], ['delivery_terms', 'Yetkazish shartlari'], ['image', 'Rasm havolasi']] as const).map(([k, l]) => <div key={k}><label htmlFor={`ug-${k}`}>{l}</label><input id={`ug-${k}`} value={g[k]} onChange={(e) => setG({ ...g, [k]: e.target.value })} /></div>)}
        <p className="muted small">Masalan: iPhone 18 Pro — 40 000 UzCoin, Samsung Galaxy S25 Ultra — 15 000 UzCoin (namunaviy narxlar, admin belgilaydi).</p>
        <button className="btn mt8" disabled={g.title.trim().length < 2 || !Number(g.price_coins)} onClick={() => call(() => api('/admin/uzcoin/gifts', { method: 'POST', body: { title: g.title, description: g.description || undefined, price_coins: Number(g.price_coins), stock: Number(g.stock) || 0, cost_minor: g.cost ? Number(g.cost.replace(/\D/g, '')) * 100 : undefined, delivery_terms: g.delivery_terms || undefined, images: g.image ? [g.image] : [], status: 'draft' } }).then(() => setG({ title: '', description: '', price_coins: '', stock: '1', cost: '', delivery_terms: '', image: '' })), '✓ Qoralama sovg‘a qo‘shildi')}>Saqlash</button>
      </details>
    </section>
  );
}
