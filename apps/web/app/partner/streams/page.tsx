'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';
import { BucketPills, Chips, LinkBox, PERIODS } from '../shared';

export default function PartnerStreams() {
  const { lang } = useI18n();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [period, setPeriod] = useState('all');
  const [items, setItems] = useState<any[] | null>(null);
  const [err, setErr] = useState<any>(null);
  const load = () => {
    setErr(null);
    const qs = new URLSearchParams({ period });
    if (query) qs.set('q', query);
    api(`/partner/streams?${qs}`).then((r) => setItems(r.items)).catch(setErr);
  };
  useEffect(load, [query, period]);
  return (
    <>
      <div className="spread"><h1>Oqimlar <span className="muted">{items ? `${items.length} ta` : ''}</span></h1><Link href="/partner/market" className="btn secondary">+ Yangi oqim</Link></div>
      <form className="search plain" role="search" onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); }}>
        <label htmlFor="sq" className="sr-only">Oqim qidirish</label>
        <input id="sq" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Oqim yoki mahsulot nomi…" />
        <button className="search-btn" aria-label="Izlash">Izlash</button>
      </form>
      <Chips items={PERIODS} value={period} onChange={setPeriod} label="Davr" />
      {err && <div className="notice" role="alert">{err.code}</div>}
      {items === null && !err && <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>}
      {items && items.length === 0 && <div className="empty"><p>Hali oqim yo‘q.</p><Link className="btn" href="/partner/market">Marketdan mahsulot tanlash</Link></div>}
      <div className="slist">
        {items?.map((s) => {
          const name = s.product_name ? pick(s.product_name, lang) : 'Umumiy havola';
          const conv = s.clicks ? Math.round((s.orders.total / s.clicks) * 1000) / 10 : null;
          return (
            <article key={s.id} className="scard">
              <div className="scard-top">
                {s.image ? <img src={s.image} alt="" width={96} height={96} /> : <div className="ph sm" aria-hidden />}
                <div className="scard-info">
                  <h3>{name}</h3>
                  <div className="price ok-t">{s.price_minor ? som(s.price_minor) : ''}</div>
                  <div className="row" style={{ gap: 6 }}>
                    <span className="pill">{s.name ?? s.code}</span>
                    {s.stock <= 5 && <span className="pill b-returned">📦 {s.stock} dona · Kam qoldi</span>}
                  </div>
                </div>
                <button type="button" className="icon-btn" aria-label="Oqimni arxivlash" title="Arxivlash" onClick={async () => {
                  if (!confirm('Oqim arxivlansinmi? Havola endi yangi buyurtmani sizga bog‘lamaydi (tarix saqlanadi).')) return;
                  try { await api(`/partner/streams/${s.id}`, { method: 'DELETE' }); load(); } catch (e: any) { setErr(e); }
                }}>🗑</button>
              </div>
              <LinkBox url={s.url} shareText={`${name}${s.price_minor ? ` — ${som(s.price_minor)}` : ''}`} />
              <div className="money-row">
                <div className="m-ok"><span>Foyda</span><b>{som(s.earned_minor)}</b></div>
                <div className="m-wait"><span>Kutilmoqda</span><b>{som(s.pending_minor)}</b></div>
              </div>
              <div className="muted small">👆 {s.clicks} bosish{conv !== null ? ` · konversiya ${conv}%` : ''}</div>
              <BucketPills c={s.orders} />
              <div className="muted small">🕒 {new Date(s.created_at).toLocaleString('uz-UZ', { dateStyle: 'short', timeStyle: 'short' })}</div>
            </article>
          );
        })}
      </div>
    </>
  );
}
