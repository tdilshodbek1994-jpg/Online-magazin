'use client';
import { useEffect, useState } from 'react';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';
import { errText } from '@/lib/errors';

export const BUCKETS_UZ: [string, string][] = [['all', 'Barchasi'], ['new', 'Yangi'], ['accepted', 'Qabul qilindi'], ['shipping', 'Yetkazilmoqda'], ['delivered', 'Yetkazildi'], ['returned', 'Qaytdi'], ['cancelled', 'Bekor qilingan']];
const LABEL = Object.fromEntries(BUCKETS_UZ) as Record<string, string>;

/**
 * Supervisor order list (same look as the partner list): product, status, sum, customer and date on one card.
 * Tapping a card opens the order where it can be confirmed; the operator who worked on it is shown on the card.
 * `filter` is extra query (partner_id=… or operator_id=…).
 */
export function AdminOrderList({ filter = '', period = 'all', initialStatus = 'all' }: { filter?: string; period?: string; initialStatus?: string }) {
  const { lang } = useI18n();
  const [status, setStatus] = useState(initialStatus);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const [limit, setLimit] = useState(10);
  useEffect(() => { setStatus(initialStatus); }, [initialStatus]);
  useEffect(() => {
    setErr(null);
    const qs = new URLSearchParams({ status, period, limit: String(limit) });
    if (query) qs.set('q', query);
    api(`/admin/orders?${qs}${filter ? `&${filter}` : ''}`).then(setData).catch(setErr);
  }, [status, period, query, filter, limit]);
  const c = data?.counts ?? {};
  return (
    <section className="aol">
      <form className="search plain" role="search" onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); setLimit(10); }}>
        <label htmlFor="aol-q" className="sr-only">Buyurtma qidirish</label>
        <input id="aol-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Raqam, telefon yoki mahsulot…" />
        <button className="search-btn" aria-label="Izlash">🔍</button>
      </form>
      <div className="chips" role="group" aria-label="Holat">
        {BUCKETS_UZ.map(([k, l]) => <button key={k} type="button" className={`chip ${status === k ? 'on' : ''}`} aria-pressed={status === k} onClick={() => { setStatus(k); setLimit(10); }}>{l} ({k === 'all' ? c.total ?? 0 : c[k] ?? 0})</button>)}
      </div>
      {err && <div className="notice" role="alert">{errText(err)}</div>}
      {!data && !err && <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>}
      {data?.items.length === 0 && <div className="empty">Buyurtma topilmadi</div>}
      <div className="slist">
        {data?.items.map((o: any) => (
          <a key={o.id} href={`/ops?order=${o.id}`} className="scard ocard">
            <div className="spread">
              <b className="ocard-items">{(o.items ?? []).map((i: any) => `${pick(i.name, lang)}${i.qty > 1 ? ` × ${i.qty}` : ''}`).join(', ') || o.number}</b>
              <span className={`pill b-${o.bucket}`}>{LABEL[o.bucket] ?? o.bucket}</span>
            </div>
            <div className="spread small">
              <b className="ok-t">{som(o.payable_minor)}</b>
              <span className="muted">{o.customer_name ?? '—'} · {new Date(o.created_at).toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} ›</span>
            </div>
            <div className="small muted">{o.number}{o.partner_code ? ` · 🤝 ${o.partner_code}` : ''} · 🎧 {o.operator_name ?? 'operator olmagan'}</div>
          </a>
        ))}
      </div>
      {data && data.items.length >= limit && <button className="btn secondary full mt8" onClick={() => setLimit(Math.min(100, limit + 10))}>Yana 10 ta</button>}
    </section>
  );
}
