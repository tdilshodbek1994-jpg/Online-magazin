'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Async } from '@/components/Header';
import { api, som } from '@/lib/api';
import { BUCKET_LABEL, Chips, PERIODS, TelegramConnect, usePartnerMe } from './shared';

function ApplyForm({ onDone }: { onDone: () => void }) {
  const [apply, setApply] = useState({ name: '', channels: '' });
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="card" style={{ maxWidth: 560 }}>
      <h1>Hamkor bo‘lish</h1>
      <p>Mahsulotlarimizni Telegram, Instagram yoki do‘stlaringiz orqali sotib, har bir yetkazilgan buyurtmadan pul ishlang.</p>
      {msg && <div className="notice" role="alert">{msg}</div>}
      <label htmlFor="dn">Ko‘rsatiladigan ism</label><input id="dn" value={apply.name} onChange={(e) => setApply({ ...apply, name: e.target.value })} />
      <label htmlFor="ch">Kanallar (Telegram, Instagram…)</label><input id="ch" value={apply.channels} onChange={(e) => setApply({ ...apply, channels: e.target.value })} />
      <p className="muted">Ariza yuborish bilan <a href="/legal/partner">hamkorlik shartnomasi</a>ni qabul qilasiz. Admin tasdiqlagandan so‘ng faol bo‘ladi.</p>
      <button className="btn" onClick={async () => { setMsg(null); try { await api('/partner/apply', { method: 'POST', body: { display_name: apply.name, channels: apply.channels, accept_agreement: true } }); onDone(); } catch (e: any) { setMsg(e.code ?? 'ERROR'); } }}>Ariza yuborish</button>
    </div>
  );
}

export default function PartnerDashboard() {
  const { me, error, reload } = usePartnerMe();
  const [period, setPeriod] = useState('today');
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const [day, setDay] = useState<any>(null);
  const [support, setSupport] = useState<string | null>(null);
  useEffect(() => { api('/partner/leaderboard?period=today').then((r) => setDay(r.items[0] ?? null)).catch(() => {}); api('/features').then((f) => setSupport(f.support_telegram ?? null)).catch(() => {}); }, [me]);
  useEffect(() => {
    if (!me || me.status === 'pending' || me.status === 'rejected') return;
    setErr(null);
    api(`/partner/dashboard?period=${period}`).then(setD).catch(setErr);
  }, [me, period]);

  if (me === null) return <ApplyForm onDone={reload} />;
  return (
    <Async loading={me === undefined && !error} error={error} onRetry={reload}>
      {me && (me.status === 'pending' || me.status === 'rejected') ? (
        <div className="card"><h1>Hamkor kabineti · <code>{me.code}</code></h1><p className="notice">{me.status === 'pending' ? 'Arizangiz ko‘rib chiqilmoqda. Tasdiqlangach bu yerda Market va oqimlar ochiladi.' : 'Ariza rad etilgan. Savollar bo‘lsa, qo‘llab-quvvatlashga yozing.'}</p></div>
      ) : me && (
        <>
          <section className="pd-hero">
            <div className="pd-avatar" aria-hidden>{(me.display_name || '?').slice(0, 2).toUpperCase()}</div>
            <div>
              <h1>{me.display_name}</h1>
              <div className="muted-inv">Hamkor kodi: <code>{me.code}</code>{me.status !== 'active' && <span className="badge"> {me.status}</span>}</div>
              {support && <a className="support-btn" href={support} target="_blank" rel="noopener noreferrer">✈️ Qo‘llab-quvvatlash</a>}
            </div>
          </section>

          <section className="balance-card">
            <div className="bc-main"><span>Hisobingizda</span><b>{som(me.balances.available_minor)}</b></div>
            <div className="bc-row">
              <div><span>Taxminiy</span><b>{som(me.balances.estimated_minor)}</b></div>
              <div><span>Kutilmoqda</span><b>{som(me.balances.pending_minor)}</b></div>
              <div><span>Yechish mumkin</span><b>{som(me.balances.available_minor)}</b></div>
            </div>
            <Link href="/partner/payouts" className="btn bc-btn">Pul yechish</Link>
          </section>

          <TelegramConnect />

          <section className="rank-card day-card">
            <div className="rank-badge">👑</div>
            <div><b>Kun admini</b><div className="muted">{day ? `${day.name}${day.me ? ' (siz!)' : ''} — bugun ${day.delivered} yetkazilgan / ${day.total} buyurtma` : 'Bugun hali yetakchi yo‘q — birinchi bo‘ling!'}</div></div>
          </section>

          {d?.month_rank && (
            <section className="rank-card">
              <div className="rank-badge">#{d.month_rank.rank}</div>
              <div><b>Shu oydagi o‘rningiz</b><div className="muted">{d.month_rank.delivered} ta yetkazilgan buyurtma</div></div>
              <Link href="/partner/top" className="see-all">TOP hamkorlar →</Link>
            </section>
          )}

          <div className="rail-head" style={{ marginTop: 20 }}><h2>Natijalar</h2></div>
          <Chips items={PERIODS} value={period} onChange={setPeriod} label="Davr" />
          {err && <div className="notice" role="alert">{err.code}</div>}
          {d && (
            <>
              <div className="stat-grid">
                <div className="stat s-total"><b>{d.orders.total}</b><span>Jami buyurtmalar</span></div>
                {(['new', 'accepted', 'shipping', 'delivered', 'returned', 'cancelled'] as const).map((k) => (
                  <Link key={k} href={`/partner/requests?status=${k}&period=${period}`} className={`stat s-${k}`}><b>{d.orders[k]}</b><span>{BUCKET_LABEL[k]}</span></Link>
                ))}
                <div className="stat s-rate"><b>{d.delivery_rate_30d === null ? '—' : `${d.delivery_rate_30d}%`}</b><span>Yetkazish foizi (30 kun)</span></div>
              </div>
              <div className="kpi-row">
                <div className="card kpi"><span className="muted">Bosishlar</span><b>{d.clicks}</b></div>
                <div className="card kpi"><span className="muted">Konversiya</span><b>{d.conversion_pct === null ? '—' : `${d.conversion_pct}%`}</b></div>
                <div className="card kpi"><span className="muted">Kutilayotgan daromad</span><b>{som(d.earned.estimated_minor)}</b></div>
                <div className="card kpi"><span className="muted">Tasdiqlangan daromad</span><b>{som(d.earned.confirmed_minor)}</b></div>
              </div>
            </>
          )}

          <div className="tile-grid">
            <Link href="/partner/requests" className="tile-link"><span>📋</span>So‘rovlar (buyurtmalar)</Link>
            <Link href="/partner/market" className="tile-link"><span>🛍️</span>Market — mahsulot tanlash</Link>
            <Link href="/partner/streams" className="tile-link"><span>🔗</span>Oqimlarim</Link>
            <Link href="/partner/order" className="tile-link"><span>📞</span>Mijoz uchun buyurtma</Link>
            <Link href="/partner/payouts" className="tile-link"><span>💳</span>Balans tarixi va to‘lovlar</Link>
            <Link href="/partner/top" className="tile-link"><span>🏆</span>TOP hamkorlar</Link>
            <Link href="/partner/notifications" className="tile-link"><span>🔔</span>Bildirishnomalar</Link>
            <Link href="/partner/about" className="tile-link"><span>📘</span>Dastur haqida</Link>
          </div>
        </>
      )}
    </Async>
  );
}
