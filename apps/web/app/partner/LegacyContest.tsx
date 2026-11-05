'use client';
import { Podium } from '@/components/Podium';
import { som } from '@/lib/api';
import { useEffect, useState } from 'react';

const MONTHS = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];
export const fmtDate = (d: string) => { const x = new Date(new Date(d).getTime() + 5 * 3600000); return `${x.getUTCDate()}-${MONTHS[x.getUTCMonth()]}`; };
export const left = (d: string) => { const ms = new Date(d).getTime() - Date.now(); if (ms <= 0) return 'tugadi'; const days = Math.floor(ms / 86400000); const h = Math.floor((ms % 86400000) / 3600000); return days ? `${days} kun ${h} soat qoldi` : `${h} soat qoldi`; };
const medal = (r: number) => (r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : `#${r}`);


/** Live countdown boxes (days : hours : minutes : seconds). */
function Countdown({ to }: { to: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const ms = Math.max(0, Date.parse(to) - now);
  const parts: [number, string][] = [[Math.floor(ms / 86400000), 'kun'], [Math.floor((ms % 86400000) / 3600000), 'soat'], [Math.floor((ms % 3600000) / 60000), 'daqiqa'], [Math.floor((ms % 60000) / 1000), 'soniya']];
  return <div className="kc-count" aria-label="Tugashiga qolgan vaqt">{parts.map(([v, l]) => <div key={l}><b>{String(v).padStart(2, '0')}</b><span>{l}</span></div>)}</div>;
}

/** Contest card: hero banner with live countdown, period bar, prize podium, my status, rules, TOP board. */
export function ContestCard({ c }: { c: any }) {
  const active = c.status === 'active';
  const start = Date.parse(c.starts_at), end = Date.parse(c.ends_at);
  const total = Math.max(1, Math.round((end - start) / 86400000));
  const passed = Math.min(total, Math.max(0, Math.round((Date.now() - start) / 86400000)));
  const pct = Math.min(100, Math.max(0, ((Date.now() - start) / (end - start)) * 100));
  const prizes = [...(c.prizes ?? [])].sort((x: any, y: any) => x.place - y.place);
  const podium = [prizes.find((p: any) => p.place === 2), prizes.find((p: any) => p.place === 1), prizes.find((p: any) => p.place === 3)];
  const others = prizes.filter((p: any) => p.place > 3);
  const byMoney = c.metric === 'delivered_sales';
  const minNeed = Math.max(1, Number(c.min_delivered ?? 1));
  const myDelivered = Number(c.me?.delivered ?? 0);
  const prizeText = (p: any) => `${p.text ?? ''}${p.amount_minor ? `${p.text ? ' + ' : ''}${som(p.amount_minor)}` : ''}`;
  return (
    <article className={`kc ${active ? '' : 'kc-done'}`}>
      <header className="kc-hero">
        <div className="kc-glow" aria-hidden />
        <div className="kc-top"><span className="kc-badge">{active ? '🔥 Davom etmoqda' : '🏁 Yakunlangan'}</span><span className="kc-dates">{fmtDate(c.starts_at)} — {fmtDate(c.ends_at)}</span></div>
        <div className="kc-trophy" aria-hidden>🏆</div>
        <h3 className="kc-title">{c.title}</h3>
        <div className="kc-sub">{byMoney ? 'Yetkazilgan savdo summasi' : 'Yetkazilgan buyurtmalar soni'} bo‘yicha{minNeed > 1 ? ` · sovringa da’vogar bo‘lish uchun kamida ${minNeed} ta` : ''}</div>
        {active ? <Countdown to={c.ends_at} /> : <div className="kc-ended">Konkurs yakunlandi — natijalar pastda</div>}
        <div className="kc-period"><div className="kc-bar"><i style={{ width: `${pct}%` }} /></div><span>{passed}/{total} kun o‘tdi</span></div>
      </header>

      {prizes.length > 0 && (
        <section className="kc-sec">
          <h4 className="kc-h">🎁 Sovrinlar</h4>
          <div className="kc-prizes">
            {podium.map((p: any, i: number) => p ? (
              <div key={p.place} className={`kc-prize kc-p${p.place}`} style={{ order: i }}>
                <span className="kc-medal">{medal(p.place)}</span>
                <b className="kc-place">{p.place}-o‘rin</b>
                <span className="kc-gift">{prizeText(p)}</span>
              </div>
            ) : <div key={`e${i}`} style={{ order: i }} />)}
          </div>
          {others.length > 0 && <div className="kc-more">{others.map((p: any) => <span key={p.place}>{p.place}-o‘rin: <b>{prizeText(p)}</b></span>)}</div>}
        </section>
      )}

      <section className="kc-sec">
        <h4 className="kc-h">👤 Mening holatim</h4>
        {c.me ? (
          <div className="kc-me">
            <div className="kc-rank"><span>O‘rnim</span><b>#{c.me.rank}</b></div>
            <div className="kc-me-r">
              <div className="spread small"><span>{byMoney ? som(c.me.score) : `${myDelivered} ta yetkazilgan`}</span>{!byMoney && <span className="muted">kamida {minNeed} ta kerak</span>}</div>
              {!byMoney && <div className="kc-bar sm"><i style={{ width: `${Math.min(100, (myDelivered / minNeed) * 100)}%` }} /></div>}
              <div className="small">{!byMoney && myDelivered < minNeed ? `Sovringa da’vogar bo‘lish uchun yana ${minNeed - myDelivered} ta yetkazilgan buyurtma kerak.` : c.me.rank <= 3 ? '🔥 Siz sovrinli o‘rindasiz — shu sur’atni saqlang!' : 'Siz sovringa da’vogarsiz — TOP 3 ga intiling!'}</div>
            </div>
          </div>
        ) : <div className="kc-empty">Hali reytingda emassiz. Birinchi yetkazilgan buyurtmangizdan keyin shu yerda o‘rningiz chiqadi{minNeed > 1 ? ` (sovringa da’vogar bo‘lish uchun kamida ${minNeed} ta)` : ''}.</div>}
      </section>

      {c.description && (
        <details className="kc-sec kc-rules">
          <summary><span className="kc-h">📜 Konkurs shartlari</span><span className="kc-chev" aria-hidden>▾</span></summary>
          <Rules text={c.description} full />
        </details>
      )}

      {c.top?.length > 0 && <div className="kc-board"><Podium boxLabel={byMoney ? 'Savdo' : 'Yetkazildi'} rows={c.top.map((r: any) => ({ rank: r.rank, name: r.name, value: byMoney ? som(r.score) : `${r.delivered} ta`, num: Number(byMoney ? r.score : r.delivered), me: r.me, avatar: r.avatar }))} /></div>}
    </article>
  );
}

/** Contest rules keep the owner's line breaks and numbering; long text is folded to a few lines with a toggle. */
export function Rules({ text, full = false }: { text: string; full?: boolean }) {
  const [open, setOpen] = useState(false);
  // "… savdo. 1. Barcha … 2. Shaxsiy …" written on one line → put numbered points and emoji headers on their own lines
  const pretty = text.replace(/\s+(?=(\d{1,2}[.)]\s))/g, '\n').replace(/\s+(?=[📅🎯✅🏆🎁⚠️🔥💰📌👉])/gu, '\n').trim();
  const long = !full && (pretty.length > 220 || pretty.split('\n').length > 4);
  return (
    <div className="rules">
      <p className={`rules-t ${long && !open ? 'clamp' : ''}`}>{pretty}</p>
      {long && <button type="button" className="link-btn small" onClick={() => setOpen(!open)}>{open ? 'Yig‘ish ▴' : 'Shartlarni to‘liq o‘qish ▾'}</button>}
    </div>
  );
}
