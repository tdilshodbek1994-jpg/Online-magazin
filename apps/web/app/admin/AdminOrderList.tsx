'use client';
import { useEffect, useState } from 'react';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';
import { errText } from '@/lib/errors';

export const BUCKETS_UZ: [string, string][] = [['all', 'Barchasi'], ['new', 'Yangi'], ['accepted', 'Tasdiqlandi'], ['shipping', 'Yo‘lda'], ['delivered', 'Yetkazildi'], ['returned', 'Qaytarildi'], ['cancelled', 'Bekor qilindi']];
const LABEL = Object.fromEntries(BUCKETS_UZ) as Record<string, string>;
const MON = ['yan', 'fev', 'mar', 'apr', 'may', 'iyun', 'iyul', 'avg', 'sen', 'okt', 'noy', 'dek'];
/** «3-noy, 07:35» in Tashkent time (no ambiguous 03/11). */
const when = (iso: string) => { const d = new Date(new Date(iso).getTime() + 5 * 3600e3); return `${d.getUTCDate()}-${MON[d.getUTCMonth()]}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
const itemsText = (o: any, lang: any) => { const it = o.items ?? []; if (!it.length) return 'Mahsulot ko‘rsatilmagan'; const first = `${pick(it[0].name, lang)}${it[0].qty > 1 ? ` × ${it[0].qty}` : ''}`; return it.length > 1 ? `${first} va yana ${it.length - 1} ta` : first; };

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
            <div className="oc-top">
              <b className="ocard-items">{itemsText(o, lang)}</b>
              <span className={`oc-st oc-${o.bucket}`}>{LABEL[o.bucket] ?? o.bucket}</span>
            </div>
            <div className="oc-mid">
              <b className="oc-sum">{som(o.payable_minor)}</b>
              <span className="oc-date">{when(o.created_at)} ›</span>
            </div>
            <div className="oc-meta">
              <span>👤 {o.customer_name ?? '—'}</span>
              {o.partner_code && <span>🤝 {o.partner_code}</span>}
              <span className={o.operator_name ? '' : 'oc-none'}>🎧 {o.operator_name ?? 'operator yo‘q'}</span>
              <span className="oc-num">{o.number}</span>
            </div>
          </a>
        ))}
      </div>
      {data && data.items.length >= limit && <button className="btn secondary full mt8" onClick={() => setLimit(Math.min(100, limit + 10))}>Yana 10 ta</button>}
    </section>
  );
}
