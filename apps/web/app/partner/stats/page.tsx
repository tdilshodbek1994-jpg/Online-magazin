'use client';
import { useEffect, useState } from 'react';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';
import { BucketPills, Chips, PERIODS } from '../shared';
import { Insights } from './Insights';

export default function PartnerStats() {
  const { lang } = useI18n();
  const [group, setGroup] = useState('stream');
  const [period, setPeriod] = useState('month');
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  useEffect(() => { setErr(null); setData(null); api(`/partner/stats?group=${group}&period=${period}`).then(setData).catch(setErr); }, [group, period]);
  const sum = (data?.items ?? []).reduce((a: any, r: any) => ({ clicks: a.clicks + r.clicks, total: a.total + r.orders.total, delivered: a.delivered + r.orders.delivered, earned: a.earned + BigInt(r.earned_minor), pending: a.pending + BigInt(r.pending_minor) }), { clicks: 0, total: 0, delivered: 0, earned: 0n, pending: 0n });
  return (
    <>
      <h1>Statistika</h1>
      <Insights />
      <h2>Batafsil jadval</h2>
      <Chips items={[['stream', 'Oqim bo‘yicha'], ['day', 'Sana bo‘yicha']]} value={group} onChange={setGroup} label="Guruhlash" />
      <Chips items={PERIODS} value={period} onChange={setPeriod} label="Davr" />
      {err && <div className="notice" role="alert">{err.code}</div>}
      {data && (
        <div className="kpi-row">
          <div className="card kpi"><span className="muted">Bosishlar</span><b>{sum.clicks}</b></div>
          <div className="card kpi"><span className="muted">Buyurtmalar</span><b>{sum.total}</b></div>
          <div className="card kpi"><span className="muted">Yetkazilgan</span><b>{sum.delivered}</b></div>
          <div className="card kpi"><span className="muted">Daromad (tasdiqlangan)</span><b>{som(sum.earned.toString())}</b></div>
          <div className="card kpi"><span className="muted">Kutilmoqda</span><b>{som(sum.pending.toString())}</b></div>
        </div>
      )}
      {!data && !err && <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>}
      {data && data.items.length === 0 && <div className="empty">Bu davrda ma’lumot yo‘q</div>}
      <div className="slist">
        {data?.items.map((r: any) => (
          <article key={r.key} className="scard">
            <div className="spread">
              <div>
                <h3>{group === 'day' ? new Date(r.key).toLocaleDateString('uz-UZ', { day: '2-digit', month: 'long', year: 'numeric' }) : r.label ?? 'To‘g‘ridan-to‘g‘ri (havolasiz)'}</h3>
                {r.product_name && <div className="muted small">{pick(r.product_name, lang)}</div>}
              </div>
              <div className="big-num ok-t">{r.orders.delivered}</div>
            </div>
            <div className="muted small">👆 {r.clicks} bosish · Yetkazish foizi: {r.delivery_rate_pct === null ? '—' : `${r.delivery_rate_pct}%`}</div>
            <div className="money-row">
              <div className="m-ok"><span>Daromad</span><b>{som(r.earned_minor)}</b></div>
              <div className="m-wait"><span>Kutilmoqda</span><b>{som(r.pending_minor)}</b></div>
            </div>
            <BucketPills c={r.orders} />
          </article>
        ))}
      </div>
    </>
  );
}
