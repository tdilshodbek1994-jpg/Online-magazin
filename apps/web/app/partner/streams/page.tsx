'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';
import { BucketPills, Chips, LinkBox, PERIODS } from '../shared';
import { errText } from '@/lib/errors';

const PAGE = 20;

export default function PartnerStreams() {
  const { lang } = useI18n();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [period, setPeriod] = useState('all');
  const [items, setItems] = useState<any[] | null>(null);
  const [err, setErr] = useState<any>(null);
  const [sort, setSort] = useState('new');
  const [onlyStock, setOnlyStock] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const load = () => {
    setErr(null);
    const qs = new URLSearchParams({ period });
    if (query) qs.set('q', query);
    api(`/partner/streams?${qs}`).then((r) => setItems(r.items)).catch(setErr);
  };
  useEffect(load, [query, period]);
  useEffect(() => setShown(PAGE), [query, period]);
  const key: Record<string, (x: any) => number> = { earned: (x) => Number(x.earned_minor ?? 0), orders: (x) => Number(x.orders?.total ?? 0), clicks: (x) => Number(x.clicks ?? 0) };
  const list = (items ?? []).filter((x) => !onlyStock || !x.product_name || Number(x.stock) > 0)
    .slice().sort((a, b) => (key[sort] ? key[sort](b) - key[sort](a) : 0));
  return (
    <>
      <div className="spread"><h1>Oqimlar <span className="muted">{items ? `${items.length} ta` : ''}</span></h1><Link href="/partner/market" className="btn secondary">+ Yangi oqim</Link></div>
      <form className="search plain" role="search" onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); }}>
        <label htmlFor="sq" className="sr-only">Oqim qidirish</label>
        <input id="sq" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Oqim yoki mahsulot nomi…" />
        <button className="search-btn" aria-label="Izlash">Izlash</button>
      </form>
      <Chips items={PERIODS} value={period} onChange={setPeriod} label="Davr" />
      {err && <div className="notice" role="alert">{errText(err)}</div>}
      {items === null && !err && <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>}
      {items && items.length === 0 && <div className="empty"><p>Hali oqim yo‘q.</p><Link className="btn" href="/partner/market">Marketdan mahsulot tanlash</Link></div>}
      {items && items.length > 0 && (
        <div className="s-tools">
          <label className="sr-only" htmlFor="ssort">Tartib</label>
          <select id="ssort" value={sort} onChange={(e) => { setSort(e.target.value); setShown(PAGE); }}>
            <option value="new">Avval yangilari</option>
            <option value="earned">Ko‘p daromad keltirgan</option>
            <option value="orders">Ko‘p buyurtma</option>
            <option value="clicks">Ko‘p bosilgan</option>
          </select>
          <label className="s-check"><input type="checkbox" checked={onlyStock} onChange={(e) => { setOnlyStock(e.target.checked); setShown(PAGE); }} /> Faqat sotuvdagilar</label>
        </div>
      )}
      <div className="slist">
        {list.slice(0, shown).map((s) => {
          const name = s.product_name ? pick(s.product_name, lang) : 'Umumiy havola';
          const conv = s.clicks >= 30 ? Math.round((s.orders.total / s.clicks) * 1000) / 10 : null; // fewer than 30 clicks: no misleading %
          const ordersHref = (st: string) => `/partner/orders?link=${s.id}&link_name=${encodeURIComponent(s.name ?? name)}&status=${st}&period=${period}`;
          return (
            <article key={s.id} className="scard s2">
              <div className="s2-top">
                {s.image ? <img src={s.image} alt="" width={64} height={64} /> : <div className="ph sm" aria-hidden />}
                <div className="s2-info">
                  <h3>{name}</h3>
                  <div className="s2-meta">
                    {s.price_minor && <b className="ok-t">{som(s.price_minor)}</b>}
                    <span className="pill">{s.name ?? s.code}</span>
                    {s.product_name && (Number(s.stock) <= 0 ? <span className="pill st-off">Tugagan</span> : Number(s.stock) <= 5 ? <span className="pill b-returned">Kam qoldi: {s.stock} dona</span> : null)}
                  </div>
                </div>
              </div>
              <LinkBox url={s.url} shareText={`${name}${s.price_minor ? ` — ${som(s.price_minor)}` : ''}`} />
              <div className="s2-stats">
                <Link href={`/partner/analytics/link/${s.id}`}><small>Daromad</small><b className="ok-t">{som(s.earned_minor)}</b></Link>
                <Link href={ordersHref('all')}><small>Kutilmoqda</small><b>{som(s.pending_minor)}</b></Link>
                <Link href={ordersHref('all')}><small>Buyurtma</small><b>{s.orders.total ?? 0}</b></Link>
                <span><small>Bosish</small><b>{s.clicks}</b></span>
              </div>
              <details className="s2-more">
                <summary>Batafsil</summary>
                <BucketPills c={s.orders} href={ordersHref} />
                <div className="muted small">{conv !== null ? `Konversiya ${conv}%` : s.clicks ? 'Konversiya: ma’lumot hali kam' : 'Hali bosilmagan'} · ochilgan {new Date(s.created_at).toLocaleDateString('uz-UZ')}</div>
                <div className="row" style={{ gap: 8 }}>
                  <Link className="btn secondary sm" href={`/partner/analytics/link/${s.id}`}>Hisob-kitob</Link>
                  <Link className="btn secondary sm" href={`/partner/expenses?link=${s.id}`}>Xarajat qo‘shish</Link>
                  <button type="button" className="btn secondary sm danger-t" onClick={async () => {
                    if (!confirm('Oqim arxivlansinmi? Havola endi yangi buyurtmani sizga bog‘lamaydi (tarix saqlanadi).')) return;
                    try { await api(`/partner/streams/${s.id}`, { method: 'DELETE' }); load(); } catch (e: any) { setErr(e); }
                  }}>Arxivlash</button>
                </div>
              </details>
            </article>
          );
        })}
      </div>
      {list.length > shown && <button className="btn secondary full mt8" onClick={() => setShown(shown + PAGE)}>Yana ko‘rsatish ({list.length - shown} ta qoldi)</button>}
      {items && items.length > 0 && list.length === 0 && <p className="muted">Bu filtr bo‘yicha oqim yo‘q.</p>}
    </>
  );
}
