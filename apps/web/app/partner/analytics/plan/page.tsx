'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';

/** Rejalashtirish (spec §18): a clearly labelled estimate — nothing is written to wallet, orders or payouts. */
export default function Plan() {
  const { lang } = useI18n();
  const [products, setProducts] = useState<any[]>([]);
  const [f, setF] = useState({ product_id: '', q1: '30', q2: '10', q3: '0', spend: '500000', rate: '80' });
  const [r, setR] = useState<any>(null);
  const [prev, setPrev] = useState<any>(null);
  useEffect(() => { api('/partner/products').then((x) => setProducts(x.items)).catch(() => {}); }, []);
  useEffect(() => { if (f.product_id) api(`/partner/products/${f.product_id}/commission-preview`).then(setPrev).catch(() => setPrev(null)); }, [f.product_id]);
  return (
    <div className="an">
      <Link href="/partner/analytics" className="see-all">← Reklama va daromad</Link>
      <h1>Rejalashtirish <span className="badge-est">TAXMIN</span></h1>
      <p className="small muted">Bu faqat taxmin: haqiqiy buyurtma, komissiya, hamyon va to‘lovlarga hech qanday ta’sir qilmaydi va kelajak daromadi kafolati emas.</p>
      <section className="card an-sec">
        <label htmlFor="pp">Mahsulot</label>
        <select id="pp" value={f.product_id} onChange={(e) => setF({ ...f, product_id: e.target.value })}><option value="">— tanlang —</option>{products.map((p) => <option key={p.id} value={p.id}>{pick(p.name, lang)}</option>)}</select>
        {prev?.items?.length > 0 && <p className="small">Komissiya: {prev.items.map((x: any) => `${x.qty} dona — ${x.total_minor === null ? 'qoida yo‘q' : som(x.total_minor)}`).join(' · ')}</p>}
        <div className="addr-grid">
          <div><label htmlFor="q1">1 donalik buyurtmalar</label><input id="q1" inputMode="numeric" value={f.q1} onChange={(e) => setF({ ...f, q1: e.target.value.replace(/\D/g, '') })} /></div>
          <div><label htmlFor="q2">2 donalik</label><input id="q2" inputMode="numeric" value={f.q2} onChange={(e) => setF({ ...f, q2: e.target.value.replace(/\D/g, '') })} /></div>
          <div><label htmlFor="q3">3 donalik</label><input id="q3" inputMode="numeric" value={f.q3} onChange={(e) => setF({ ...f, q3: e.target.value.replace(/\D/g, '') })} /></div>
          <div><label htmlFor="dr">Yetkazilish (%)</label><input id="dr" inputMode="numeric" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value.replace(/\D/g, '').slice(0, 3) })} /></div>
          <div><label htmlFor="sp">Reklama (so‘m)</label><input id="sp" inputMode="numeric" value={f.spend} onChange={(e) => setF({ ...f, spend: e.target.value.replace(/\D/g, '') })} /></div>
        </div>
        <button className="btn mt8" disabled={!f.product_id} onClick={async () => setR(await api('/partner/analytics/simulate', { method: 'POST', body: { product_id: f.product_id, orders_by_qty: { '1': Number(f.q1 || 0), '2': Number(f.q2 || 0), '3': Number(f.q3 || 0) }, ad_spend_minor: String(BigInt(f.spend || '0') * 100n), delivery_rate_bps: Math.min(100, Number(f.rate || 0)) * 100 } }))}>Hisoblash</button>
      </section>
      {r && (
        <section className="card an-sec est">
          <div className="badge-est">TAXMIN</div>
          {r.error ? <p>Bu mahsulot uchun komissiya qoidasi yo‘q.</p> : (
            <>
              {r.rows.map((x: any) => <div key={x.qty} className="sum-row"><span>{x.qty} dona × {x.delivered} yetkazilgan</span><b>{x.commission_minor === null ? 'qoida yo‘q' : som(x.commission_minor)}</b></div>)}
              <div className="sum-row"><span>Taxminiy komissiya</span><b>{som(r.commission_minor)}</b></div>
              <div className="sum-row"><span>Reklama</span><b>− {som(r.ad_spend_minor)}</b></div>
              <div className="sum-row total"><span>Taxminiy natija</span><b className={BigInt(r.result_minor) < 0n ? 'no-t' : ''}>{BigInt(r.result_minor) < 0n ? `−${som((-BigInt(r.result_minor)).toString())}` : som(r.result_minor)}</b></div>
              <p className="small muted">{r.label}</p>
            </>
          )}
        </section>
      )}
    </div>
  );
}
