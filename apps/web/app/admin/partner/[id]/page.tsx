'use client';
import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';
import { errText } from '@/lib/errors';
import { AdminOrderList, BUCKETS_UZ } from '../../AdminOrderList';

const PERIODS: [string, string][] = [['today', 'Bugun'], ['yesterday', 'Kecha'], ['week', 'Hafta'], ['month', 'Shu oy'], ['all', 'Hammasi']];

/** Supervisor watch page for one partner: how they work, what they sell, every order (open one to confirm). */
export default function PartnerWatch({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { lang } = useI18n();
  const [period, setPeriod] = useState('month');
  const [status, setStatus] = useState('all');
  const [p, setP] = useState<any>(null);
  const [prods, setProds] = useState<any[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [err, setErr] = useState<any>(null);
  useEffect(() => { try { const s = new URLSearchParams(location.search).get('status'); if (s) setStatus(s); } catch {} }, []);
  useEffect(() => {
    setErr(null);
    api(`/admin/partners/performance?period=${period}&id=${id}`).then((r) => setP(r.items[0] ?? null)).catch(setErr);
    api(`/admin/partners/${id}/products?period=${period}`).then((r) => setProds(r.items)).catch(() => setProds([]));
  }, [id, period]);
  if (err) return <div className="notice" role="alert">{errText(err)}</div>;
  if (!p) return <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>;
  const o = p.orders;
  return (
    <div className="watch">
      <Link href="/admin" className="see-all">← Boshqaruv</Link>
      <div className="spread"><div><h1>{p.display_name}</h1><div className="muted small"><code>{p.code}</code> · {p.streams} ta oqim · {new Date(p.created_at).toLocaleDateString('uz-UZ')} dan beri</div></div>
        <select aria-label="Davr" value={period} onChange={(e) => setPeriod(e.target.value)} className="req-period">{PERIODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>

      <div className="an-mini">
        <div><b>{p.clicks}</b><span>bosish</span></div>
        <div><b>{o.total}</b><span>buyurtma</span></div>
        <div><b className="ok-t">{o.delivered}</b><span>yetkazildi</span></div>
        <div><b>{p.delivery_rate_pct === null ? '—' : `${p.delivery_rate_pct}%`}</b><span>yetkazish</span></div>
      </div>
      <div className="watch-money">
        <div><span>Savdo (yetkazilgan)</span><b>{som(p.delivered_sales_minor)}</b></div>
        <div><span>Komissiya</span><b>{som(p.commission_earned_minor)}</b></div>
        <div><span>Yechish mumkin</span><b>{som(p.available_minor)}</b></div>
      </div>

      <h2 className="an-h2">Holat bo‘yicha (bosing — ro‘yxat chiqadi)</h2>
      <div className="pills">
        {BUCKETS_UZ.filter(([k]) => k !== 'all').map(([k, l]) => <button key={k} type="button" className={`pill b-${k} pill-btn ${status === k ? 'sel' : ''}`} onClick={() => { setStatus(status === k ? 'all' : k); setTimeout(() => document.getElementById('w-orders')?.scrollIntoView({ behavior: 'smooth' }), 60); }}>{l}: {o[k] ?? 0}</button>)}
      </div>

      <details className="card pp-more" open>
        <summary>Qaysi mahsulotlarni sotadi ({prods?.length ?? 0})</summary>
        {prods?.length === 0 && <p className="muted small">Bu davrda sotuv yo‘q.</p>}
        {(showAll ? prods : prods?.slice(0, 8))?.map((x) => (
          <div key={x.id} className="spread small w-prod"><a href={`/p/${x.slug}`} target="_blank" rel="noopener noreferrer">{pick(x.name, lang)}</a><span><b>{x.orders}</b> buyurtma · <b className="ok-t">{x.delivered}</b> yetkazildi · {x.units} dona</span></div>
        ))}
        {prods && prods.length > 8 && <button className="link-btn small" onClick={() => setShowAll(!showAll)}>{showAll ? 'Yig‘ish' : `Hammasi (${prods.length})`}</button>}
      </details>

      <h2 className="an-h2" id="w-orders">Buyurtmalari</h2>
      <p className="muted small">Buyurtmani bosing — ochiladi, u yerdan tasdiqlash mumkin. Har kartochkada qaysi operator ishlagani yozilgan.</p>
      <AdminOrderList filter={`partner_id=${id}`} period={period} initialStatus={status} />
    </div>
  );
}
