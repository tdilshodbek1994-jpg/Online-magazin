'use client';
import { useEffect, useState } from 'react';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';
import Link from 'next/link';
import { Chips, PERIODS } from '../shared';
import { Insights } from './Insights';
import { errText } from '@/lib/errors';
import { uzDate } from '@/lib/orderStatus';

export default function PartnerStats() {
  const { lang } = useI18n();
  const [group, setGroup] = useState('stream');
  const [period, setPeriod] = useState('month');
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const [shown, setShown] = useState(10);
  useEffect(() => { setErr(null); setData(null); setShown(10); api(`/partner/stats?group=${group}&period=${period}`).then(setData).catch(setErr); }, [group, period]);
  const sum = (data?.items ?? []).reduce((a: any, r: any) => ({ clicks: a.clicks + r.clicks, total: a.total + r.orders.total, delivered: a.delivered + r.orders.delivered, earned: a.earned + BigInt(r.earned_minor), pending: a.pending + BigInt(r.pending_minor) }), { clicks: 0, total: 0, delivered: 0, earned: 0n, pending: 0n });
  return (
    <>
      {/* Short (user: "bardak, nimaligini tushunmadim"): period, 4 numbers, one line per link; the rest folds away. */}
      <h1>Statistika</h1>
      <Chips items={PERIODS} value={period} onChange={setPeriod} label="Davr" />
      {err && <div className="notice" role="alert">{errText(err)}</div>}
      {data && (
        <div className="an-mini">
          <div><b>{sum.clicks}</b><span>bosish</span></div>
          <Link href={`/partner/orders?status=all&period=${period}`}><b>{sum.total}</b><span>buyurtma</span></Link>
          <Link href={`/partner/orders?status=delivered&period=${period}`}><b>{sum.delivered}</b><span>yetkazildi</span></Link>
          <Link href="/partner/wallet"><b className="ok-t st-money">{som(sum.earned.toString())}</b><span>topildi</span></Link>
        </div>
      )}
      {data && sum.pending > 0n && <p className="small muted">⏳ Yana {som(sum.pending.toString())} yetkazilgach qo‘shiladi.</p>}
      <div className="spread"><h2 className="an-h2">{group === 'day' ? 'Kunlar bo‘yicha' : 'Havolalar bo‘yicha'}</h2><button type="button" className="link-btn small" onClick={() => setGroup(group === 'day' ? 'stream' : 'day')}>{group === 'day' ? 'Havolalar bo‘yicha ko‘rish' : 'Kunlar bo‘yicha ko‘rish'}</button></div>
      {!data && !err && <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>}
      {data && data.items.length === 0 && <div className="empty">Bu davrda ma’lumot yo‘q</div>}
      <div className="slist">
        {data?.items.slice(0, shown).map((r: any) => {
          const linkQ = group === 'stream' && r.key !== 'direct' ? `&link=${r.key}&link_name=${encodeURIComponent(r.label ?? '')}` : '';
          return (
            <Link key={r.key} href={`/partner/orders?status=all&period=${period}${linkQ}`} className="scard an-row">
              <div className="an-row-main">
                <b>{group === 'day' ? uzDate(r.key, true) : r.label ?? 'Havolasiz (o‘zingiz kiritgan)'}</b>
                <small className="muted">{r.product_name ? `${pick(r.product_name, lang)} · ` : ''}{r.orders.total} buyurtma · {r.orders.delivered} yetkazildi</small>
              </div>
              <b className="an-row-sum ok-t">{BigInt(r.earned_minor) > 0n ? som(r.earned_minor) : <span className="muted">⏳ {som(r.pending_minor)}</span>} ›</b>
            </Link>
          );
        })}
      </div>
      {data && data.items.length > shown && <button className="btn secondary full mt8" onClick={() => setShown(shown + 10)}>Yana 10 ta ({data.items.length - shown} ta qoldi)</button>}
      <details className="card pp-more st-more">
        <summary>Mahsulotlar va hududlar bo‘yicha</summary>
        <Insights />
      </details>
    </>
  );
}
