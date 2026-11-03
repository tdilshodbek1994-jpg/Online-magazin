'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';
import { LinkBox } from '../shared';
import { errText } from '@/lib/errors';

const STATUS: Record<string, [string, string]> = {
  open: ['Yuborilgan', 'b-new'], thinking: ['Mijoz o‘ylab ko‘ryapti', 'b-accepted'], chosen: ['Mijoz tanladi', 'b-delivered'], closed: ['Yopilgan', 'b-cancelled'], expired: ['Muddati tugagan', 'b-cancelled'],
};

/** Taklif to'plami (V2 §08): when the customer has not decided yet, send 2–3 options in one link. */
export default function Offers() {
  const { lang } = useI18n();
  const [products, setProducts] = useState<any[]>([]);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [made, setMade] = useState<any>(null);
  const [items, setItems] = useState<any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => api('/partner/offers').then((r) => setItems(r.items)).catch(() => setItems([]));
  useEffect(() => { api('/partner/products').then((r) => setProducts(r.items)).catch(() => {}); void load(); }, []);
  const shown = products.filter((p) => !q || pick(p.name, lang).toLowerCase().includes(q.toLowerCase())).slice(0, 30);
  const toggle = (id: string) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= 3 ? s : [...s, id]));
  return (
    <>
      <h1>Taklif to‘plami</h1>
      <p className="muted">Mijoz hali tanlamagan bo‘lsa, 2–3 ta mahsulotni bitta havolada yuboring. Mijoz narx va xususiyatlarni solishtirib, birini tanlaydi. Narx va tavsif katalogdan olinadi — siz faqat qisqa maslahat yozasiz.</p>
      <section className="card">
        <h2>Yangi to‘plam · {sel.length}/3 tanlandi</h2>
        <label htmlFor="oq" className="sr-only">Mahsulot qidirish</label>
        <input id="oq" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Mahsulot nomi…" />
        <div className="offer-pick">
          {shown.map((p) => (
            <button type="button" key={p.id} className={`chip ${sel.includes(p.id) ? 'on' : ''}`} aria-pressed={sel.includes(p.id)} disabled={!sel.includes(p.id) && sel.length >= 3} onClick={() => toggle(p.id)}>
              {pick(p.name, lang)}{p.min_price_minor ? ` · ${som(p.min_price_minor)}` : ''}
            </button>
          ))}
        </div>
        <label htmlFor="on">Sizning maslahatingiz (ixtiyoriy)</label>
        <input id="on" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Masalan: Ikkinchisi ovozi kuchliroq, birinchisi arzonroq" />
        {err && <div className="field-error" role="alert">{err}</div>}
        <button className="btn mt8" disabled={sel.length < 2} onClick={async () => {
          setErr(null);
          try { setMade(await api('/partner/offers', { method: 'POST', body: { product_ids: sel, note: note || undefined } })); setSel([]); setNote(''); void load(); } catch (e: any) { setErr(e.code === 'POLICY_NOT_SET' ? 'Havola muddati qoidasi admin tomonidan hali belgilanmagan' : errText(e)); }
        }}>Havola yaratish</button>
        {made && <div className="mt8"><p className="notice ok">Havola tayyor — mijozga yuboring:</p><LinkBox url={made.url} shareText="Siz uchun bir nechta variant tanladim — solishtirib ko‘ring" /></div>}
      </section>

      <h2>Yuborilgan to‘plamlar</h2>
      {items === null && <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>}
      {items?.length === 0 && <div className="empty">Hali taklif to‘plami yo‘q.</div>}
      <div className="slist">
        {items?.map((o) => (
          <article key={o.id} className="scard">
            <div className="spread"><b>{(o.products ?? []).map((p: any) => pick(p.name, lang)).join(' · ')}</b><span className={`pill ${STATUS[o.status]?.[1] ?? ''}`}>{STATUS[o.status]?.[0] ?? o.status}</span></div>
            {o.note && <div className="small muted">«{o.note}»</div>}
            <div className="small">{o.seen_at ? '👀 Mijoz ochdi' : 'Mijoz hali ochmadi'}{o.wants_reminder ? ' · 🔔 eslatma so‘radi' : ''}{o.chosen ? ` · Tanladi: ${pick(o.chosen, lang)}` : ''}</div>
            <div className="spread">
              <span className="muted small">{new Date(o.created_at).toLocaleString('uz-UZ', { dateStyle: 'short', timeStyle: 'short' })}</span>
              {o.order_id ? <Link className="see-all" href={`/partner/orders/${o.order_id}`}>{o.order_masked} · pasport →</Link>
                : ['open', 'thinking'].includes(o.status) && <button className="link-btn small" onClick={async () => { await api(`/partner/offers/${o.id}/close`, { method: 'POST' }).catch(() => {}); void load(); }}>Yopish</button>}
            </div>
          </article>
        ))}
      </div>
    </>
  );
}
