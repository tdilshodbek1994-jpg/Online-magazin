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
  const [shown, setShown] = useState(10);
  useEffect(() => {
    setErr(null);
    const qs = new URLSearchParams({ status, period });
    if (query) qs.set('q', query);
    if (link) qs.set('link', link);
    setShown(10); api(`/partner/requests?${qs}`).then(setData).catch(setErr);
  }, [status, period, query, link]);
  const c = data?.counts ?? {};
  return (
    <>
      {!embedded && <h1>So‘rovlar</h1>}
      {link && <div className="filter-chip">Faqat oqim: <b>{linkName || 'tanlangan havola'}</b> <button className="link-btn small" onClick={() => setLink('')} aria-label="Oqim filtrini olib tashlash">× Hammasi</button></div>}
      {/* Tidy header (user): search + period in one row, then one row of status chips. */}
      <div className="req-top">
        <form className="search plain" role="search" onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); }}>
          <label htmlFor="rq" className="sr-only">Buyurtma qidirish</label>
          <input id="rq" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Raqam yoki mahsulot…" />
          <button className="search-btn" aria-label="Izlash">🔍</button>
        </form>
        <label htmlFor="rp" className="sr-only">Davr</label>
        <select id="rp" className="req-period" value={period} onChange={(e) => setPeriod(e.target.value)}>{PERIODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      </div>
      <Chips items={[['all', `Barchasi (${c.total ?? 0})`], ...BUCKET_ORDER.map((b) => [b, `${BUCKET_LABEL[b]} (${c[b] ?? 0})`] as [string, string]), ['callback', `Qayta qo‘ng‘iroq (${c.callback ?? 0})`], ['duplicate', `Dublikat (${c.duplicate ?? 0})`]]} value={status} onChange={setStatus} label="Holat" />
      {err && <div className="notice" role="alert">{errText(err)}</div>}
      {!data && !err && <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>}
      {data && data.items.length === 0 && <div className="empty">Ma’lumot topilmadi</div>}
      <div className="slist">
        {data?.items.slice(0, shown).map((o: any) => (
          // Compact (user: "chalkash, ko‘p info kerak emas"): product, status, bonus, date — details open inside.
          <Link key={o.id} href={`/partner/orders/${o.id}`} className="scard ocard">
            <div className="spread">
              <b className="ocard-items">{(o.items ?? []).map((i: any) => `${pick(i.product, lang)}${i.qty > 1 ? ` × ${i.qty}` : ''}`).join(', ') || o.masked_number}</b>
              <span className={`pill b-${o.bucket}`}>{o.callback ? '📞 ' : ''}{o.duplicate ? '⚠️ ' : ''}{BUCKET_LABEL[o.bucket]}</span>
            </div>
            <div className="spread small"><b className="ok-t">+{som(o.commission_minor)}</b><span className="muted">{o.customer} · {new Date(o.created_at).toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} ›</span></div>
          </Link>
        ))}
      </div>
      {data && data.items.length > shown && <button className="btn secondary full mt8" onClick={() => setShown(shown + 10)}>Yana 10 ta ko‘rsatish ({data.items.length - shown} ta qoldi)</button>}
      <p className="muted small">Mijoz ma’lumotlari maxfiylik uchun qisman yashirilgan. Buyurtmani operator tasdiqlaydi; bonus yetkazilgandan keyin hisobingizga o‘tadi.</p>
    </>
  );
}

export function RequestsList({ embedded = false }: { embedded?: boolean }) { return <Suspense fallback={null}><Requests embedded={embedded} /></Suspense>; }
