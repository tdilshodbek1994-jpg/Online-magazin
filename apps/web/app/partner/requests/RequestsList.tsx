'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';
import { BUCKET_LABEL, BUCKET_ORDER, Chips, PERIODS } from '../shared';
import { errText } from '@/lib/errors';

function Requests({ embedded = false }: { embedded?: boolean }) {
  const { lang } = useI18n();
  const sp = useSearchParams();
  const [status, setStatus] = useState(sp.get('status') ?? 'all');
  const [period, setPeriod] = useState(sp.get('period') ?? 'all');
  const [link, setLink] = useState(sp.get('link') ?? '');
  const linkName = sp.get('link_name') ?? '';
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const [shown, setShown] = useState(20);
  useEffect(() => {
    setErr(null);
    const qs = new URLSearchParams({ status, period });
    if (query) qs.set('q', query);
    if (link) qs.set('link', link);
    setShown(20); api(`/partner/requests?${qs}`).then(setData).catch(setErr);
  }, [status, period, query, link]);
  const c = data?.counts ?? {};
  return (
    <>
      {!embedded && <h1>So‘rovlar</h1>}
      {link && <div className="filter-chip">Faqat oqim: <b>{linkName || 'tanlangan havola'}</b> <button className="link-btn small" onClick={() => setLink('')} aria-label="Oqim filtrini olib tashlash">× Hammasi</button></div>}
      <form className="search plain" role="search" onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); }}>
        <label htmlFor="rq" className="sr-only">Buyurtma qidirish</label>
        <input id="rq" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buyurtma raqami yoki mahsulot…" />
        <button className="search-btn" aria-label="Izlash">Izlash</button>
      </form>
      <Chips items={PERIODS} value={period} onChange={setPeriod} label="Davr" />
      <Chips items={[['all', `Barchasi (${c.total ?? 0})`], ...BUCKET_ORDER.map((b) => [b, `${BUCKET_LABEL[b]} (${c[b] ?? 0})`] as [string, string]), ['callback', `Qayta qo‘ng‘iroq (${c.callback ?? 0})`], ['duplicate', `Dublikat (${c.duplicate ?? 0})`]]} value={status} onChange={setStatus} label="Holat" />
      {err && <div className="notice" role="alert">{errText(err)}</div>}
      {!data && !err && <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>}
      {data && data.items.length === 0 && <div className="empty">Ma’lumot topilmadi</div>}
      <div className="slist">
        {data?.items.slice(0, shown).map((o: any) => (
          <article key={o.id} className="scard">
            <div className="spread">
              <b>{o.masked_number}</b>
              <span className="row" style={{ gap: 6 }}>
                {o.callback && <span className="pill b-accepted">📞 Qayta qo‘ng‘iroq</span>}
                {o.duplicate && <span className="pill b-shipping">⚠️ Dublikat</span>}
                <span className={`pill b-${o.bucket}`}>{BUCKET_LABEL[o.bucket]}</span>
              </span>
            </div>
      {data && data.items.length > shown && <button className="btn secondary full mt8" onClick={() => setShown(shown + 20)}>Yana ko‘rsatish ({data.items.length - shown} ta qoldi)</button>}
            <div className="req-grid">
              <div><span>Mijoz</span>{o.customer} · {o.customer_phone}</div>
              <div><span>Hudud</span>{o.district ?? '—'}</div>
              <div><span>Oqim</span>{o.stream_name ?? o.stream_code ?? (o.channel === 'partner_assisted' ? 'Mijoz uchun buyurtma' : '—')}</div>
              <div><span>Bonus</span><b className="ok-t">{som(o.commission_minor)}</b></div>
            </div>
            <div className="small">{(o.items ?? []).map((i: any, k: number) => <div key={k}>{pick(i.product, lang)} × {i.qty}</div>)}</div>
            <div className="spread"><span className="muted small">🕒 {new Date(o.created_at).toLocaleString('uz-UZ', { dateStyle: 'short', timeStyle: 'short' })}</span><Link href={`/partner/orders/${o.id}`} className="see-all">Sotuv pasporti →</Link></div>
          </article>
        ))}
      </div>
      <p className="muted small">Mijoz ma’lumotlari maxfiylik uchun qisman yashirilgan. Buyurtmani operator tasdiqlaydi; bonus yetkazilgandan keyin hisobingizga o‘tadi.</p>
    </>
  );
}

export function RequestsList({ embedded = false }: { embedded?: boolean }) { return <Suspense fallback={null}><Requests embedded={embedded} /></Suspense>; }
