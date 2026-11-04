'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Async } from '@/components/Header';
import { api, som } from '@/lib/api';
import { BUCKET_LABEL, Chips, PERIODS, TelegramConnect, usePartnerMe } from './shared';
import { errText, stText } from '@/lib/errors';

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
      <button className="btn" onClick={async () => { setMsg(null); try { await api('/partner/apply', { method: 'POST', body: { display_name: apply.name, channels: apply.channels, accept_agreement: true } }); onDone(); } catch (e: any) { setMsg(errText(e)); } }}>Ariza yuborish</button>
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
  const [att, setAtt] = useState<any>(null);
  useEffect(() => { api('/partner/leaderboard?period=today').then((r) => setDay(r.items[0] ?? null)).catch(() => {}); api('/features').then((f) => setSupport(f.support_telegram ?? null)).catch(() => {}); }, [me]);
  useEffect(() => {
    if (!me || me.status === 'pending' || me.status === 'rejected') return;
    setErr(null);
    api(`/partner/dashboard?period=${period}`).then(setD).catch(setErr);
  }, [me, period]);
  useEffect(() => { if (me?.status === 'active') api('/partner/attention').then(setAtt).catch(() => {}); }, [me]);

  if (me === null) return <ApplyForm onDone={reload} />;
  return (
    <Async loading={me === undefined && !error} error={error} onRetry={reload}>
      {me && (me.status === 'pending' || me.status === 'rejected') ? (
        <div className="card"><h1>Hamkor kabineti · <code>{me.code}</code></h1><p className="notice">{me.status === 'pending' ? 'Arizangiz ko‘rib chiqilmoqda. Tasdiqlangach bu yerda Market va oqimlar ochiladi.' : 'Ariza rad etilgan. Savollar bo‘lsa, qo‘llab-quvvatlashga yozing.'}</p></div>
      ) : me && (
        <>
          <section className="pd-hero pd-hero2">
            <div className="pd-avatar" aria-hidden>{(me.display_name || '?').slice(0, 2).toUpperCase()}</div>
            <div className="pd-who">
              <h1>{me.display_name}</h1>
              <div className="muted-inv">Kod: <code>{me.code}</code>{me.status !== 'active' && <span className="badge"> {stText(me.status)}</span>}</div>
            </div>
            {support && <a className="pd-support" href={support} target="_blank" rel="noopener noreferrer" aria-label="Qo‘llab-quvvatlash">✈️</a>}
          </section>

          {/* Big cards: each one job, each its own colour (user request: like "Mijoz uchun buyurtma", clearly different). */}
          <div className="big-cards">
            <Link href="/partner/new" className="big-card bc-green">
              <span className="big-ico" aria-hidden>＋</span>
              <span className="big-txt"><b>Mijoz uchun buyurtma</b><small>Telefon, manzil — 1 daqiqada</small></span>
            </Link>

            <Link href="/partner/wallet" className="big-card bc-gold">
              <span className="big-ico" aria-hidden>💰</span>
              <span className="big-txt"><small>Yechish mumkin</small><b>{som(me.balances.available_minor)}</b>
                <small className="big-sub">Kutilmoqda {som(me.balances.pending_minor)} · Taxminiy {som(me.balances.estimated_minor)}</small></span>
              <span className="big-go" aria-hidden>›</span>
            </Link>

            {att && (att.action.length > 0 || att.waiting.length > 0) ? (
              <details className="big-card bc-orange big-det">
                <summary>
                  <span className="big-ico" aria-hidden>⚡</span>
                  <span className="big-txt"><b>Hozir nima qilish kerak</b>
                    <small>{att.action.length > 0 ? `${att.action.length} ta ish sizni kutyapti` : 'Sizdan amal kerak emas'}{att.waiting.length > 0 ? ` · ${att.waiting.length} ta javob kutilmoqda` : ''}</small></span>
                  <span className="big-go" aria-hidden>⌄</span>
                </summary>
                <div className="big-body">
                  {att.action.length > 0 && <AttGroup cls="act" title="Sizdan amal kerak" items={att.action} />}
                  {att.waiting.length > 0 && <AttGroup cls="wait" title="Magazin / mijoz javobini kutyapmiz" items={att.waiting} />}
                </div>
              </details>
            ) : att && BigInt(me.balances.estimated_minor) + BigInt(me.balances.pending_minor) + BigInt(me.balances.available_minor) + BigInt(me.balances.paid_minor) === 0n ? (
              <Link href="/partner/market" className="big-card bc-orange">
                <span className="big-ico" aria-hidden>🚀</span>
                <span className="big-txt"><b>Boshlash: mahsulot tanlang</b><small>Havolani joylang yoki mijoz buyurtmasini kiriting</small></span>
                <span className="big-go" aria-hidden>›</span>
              </Link>
            ) : att ? (
              <div className="big-card bc-orange"><span className="big-ico" aria-hidden>✓</span><span className="big-txt"><b>Shoshilinch ish yo‘q</b><small>Hammasi joyida</small></span></div>
            ) : null}

            <div className="big-card bc-blue big-stats">
              <div className="big-head"><Link href="/partner/stats" className="big-title-link"><b>Natijalar ›</b></Link>
                <label className="sr-only" htmlFor="pd-period">Davr</label>
                <select id="pd-period" className="big-select" value={period} onChange={(e) => setPeriod(e.target.value)}>{PERIODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              </div>
              {err && <div className="small" role="alert">{errText(err)}</div>}
              {d && (
                <div className="big-nums">
                  <Link href={`/partner/orders?status=all&period=${period}`}><b>{d.orders.total}</b><small>buyurtma</small></Link>
                  <Link href={`/partner/orders?status=new&period=${period}`}><b>{d.orders.new}</b><small>{BUCKET_LABEL.new.toLowerCase()}</small></Link>
                  <Link href={`/partner/orders?status=delivered&period=${period}`}><b>{d.orders.delivered}</b><small>yetkazildi</small></Link>
                  <Link href={`/partner/orders?status=returned&period=${period}`}><b>{d.orders.returned}</b><small>qaytdi</small></Link>
                </div>
              )}
              {d && <Link href="/partner/stats" className="big-more">{d.delivery_rate_30d === null ? 'Batafsil statistika' : `Yetkazish foizi (30 kun): ${d.delivery_rate_30d}%`} ›</Link>}
            </div>
          </div>

          {/* Small tiles: about a third of a big card. */}
          <div className="mini-tiles">
            {([
              ['/partner/orders', '📋', 'Buyurtmalar', 't1'], ['/partner/market', '🛍️', 'Market', 't2'], ['/partner/streams', '🔗', 'Oqimlar', 't3'], ['/partner/analytics', '📈', 'Reklama', 't4'],
              ['/partner/offers', '🧺', 'Taklif to‘plami', 't5'], ['/partner/contacts', '📒', 'Mijozlar', 't6'], ['/partner/stats', '📊', 'Statistika', 't7'], ['/partner/wallet', '💳', 'Hamyon', 't8'],
              ['/partner/contests', '🏆', 'Konkurs', 't1'], ['/partner/programs#bonus', '🎁', 'Bonuslar', 't2'], ['/partner/programs#jarima', '⚠️', 'Jarimalar', 't3'], ['/partner/programs#hayriya', '💝', 'Hayriya', 't4'],
              ['/partner/top', '🥇', d?.month_rank ? `TOP · #${d.month_rank.rank}` : 'TOP va holat', 't5'], ['/partner/notifications', '🔔', 'Xabarlar', 't6'], ['/partner/expenses', '🧾', 'Xarajatlar', 't7'], ['/partner/about', '📘', 'Qoidalar', 't8'],
            ] as [string, string, string, string][]).map(([href, ico, label, tone]) => (
              <Link key={href} href={href} className={`mini-tile ${tone}`}><span aria-hidden>{ico}</span>{label}</Link>
            ))}
          </div>
        </>
      )}
    </Async>
  );
}

/** One attention group: the 3 most urgent items first, the rest behind "Yana N ta" so the dashboard stays short. */
function AttGroup({ cls, title, items }: { cls: string; title: string; items: any[] }) {
  const [all, setAll] = useState(false);
  const list = all ? items : items.slice(0, 3);
  return (
    <div className={`att-group ${cls}`}>
      <h3>{title} · {items.length}</h3>
      {list.map((x: any, i: number) => <Link key={i} href={x.href ?? '/partner'} className="att-item"><b>{x.title}</b>{x.detail && <small>{x.detail}</small>}</Link>)}
      {items.length > 3 && <button type="button" className="link-btn small att-more" onClick={() => setAll(!all)}>{all ? 'Yig‘ish' : `Yana ${items.length - 3} ta ko‘rsatish`}</button>}
    </div>
  );
}
