'use client';
import { Podium } from '@/components/Podium';
import { useEffect, useState } from 'react';
import { api, som } from '@/lib/api';
import { errText } from '@/lib/errors';

const MONTHS = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];
const fmtDate = (d: string) => { const x = new Date(new Date(d).getTime() + 5 * 3600000); return `${x.getUTCDate()}-${MONTHS[x.getUTCMonth()]}`; };
const left = (d: string) => { const ms = new Date(d).getTime() - Date.now(); if (ms <= 0) return 'tugadi'; const days = Math.floor(ms / 86400000); const h = Math.floor((ms % 86400000) / 3600000); return days ? `${days} kun ${h} soat qoldi` : `${h} soat qoldi`; };
const medal = (r: number) => (r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : `#${r}`);

export default function PartnerPrograms() {
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const [amt, setAmt] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const load = () => api('/partner/programs').then(setD).catch(setErr);
  useEffect(() => { void load(); }, []);
  if (err) return <div className="notice" role="alert">{errText(err)}</div>;
  if (!d) return <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>;
  const active = d.contests.filter((c: any) => c.status === 'active');
  const past = d.contests.filter((c: any) => c.status !== 'active');
  return (
    <>
      <h1>Konkurs va bonuslar</h1>
      <nav className="chips" aria-label="Bo‘limlar">{[['konkurs', '🏆 Konkurs'], ['bonus', '🎁 Bonuslar'], ['jarima', '⚠️ Jarimalar'], ['hayriya', '💝 Hayriya qutisi']].map(([k, l]) => <a key={k} className="chip" href={`#${k}`}>{l}</a>)}</nav>

      <section id="konkurs" className="rail">
        <h2>🏆 Konkurslar</h2>
        {active.length === 0 && <div className="empty small">Hozir faol konkurs yo‘q. E’lon qilinganda shu yerda ko‘rinadi.</div>}
        {active.map((c: any) => <ContestCard key={c.id} c={c} />)}
        {past.length > 0 && <details><summary className="muted">O‘tgan konkurslar ({past.length})</summary>{past.map((c: any) => <ContestCard key={c.id} c={c} />)}</details>}
      </section>

      <section id="bonus" className="rail">
        <h2>🎁 Bonus rejalari</h2>
        {d.bonus_rules.length === 0 && <div className="empty small">Hozircha bonus rejasi yo‘q.</div>}
        <div className="slist">
          {d.bonus_rules.map((r: any) => {
            const pct = Math.min(100, Math.round((r.delivered / r.threshold_delivered) * 100));
            return (
              <article key={r.id} className="scard">
                <div className="spread"><h3>{r.name}</h3><b className="ok-t">+{som(r.amount_minor)}</b></div>
                <div className="muted small">{r.period === 'month' ? 'Har oy' : 'Har hafta'} {r.threshold_delivered} ta yetkazilgan buyurtma uchun · davr tugashiga: {left(r.period_ends)}</div>
                <div className="progress" role="progressbar" aria-valuenow={r.delivered} aria-valuemin={0} aria-valuemax={r.threshold_delivered} aria-label={r.name}><span style={{ width: `${pct}%` }} /></div>
                <div className="small">{r.awarded ? '✅ Bu davr uchun bonus berildi' : r.delivered >= r.threshold_delivered ? '🎉 Shart bajarildi — davr yakunida hisobingizga tushadi' : `${r.delivered} / ${r.threshold_delivered} — yana ${r.threshold_delivered - r.delivered} ta`}</div>
              </article>
            );
          })}
        </div>
        <h3 style={{ marginTop: 16 }}>Bonuslar tarixi</h3>
        {d.bonuses.length === 0 ? <p className="muted small">Hali bonus yo‘q.</p> : (
          <div className="slist">{d.bonuses.map((b: any) => <div key={b.id} className="scard spread"><div><b>{b.source === 'contest' ? '🏆' : '🎁'} {b.reason}</b><div className="muted small">{fmtDate(b.created_at)}</div></div><b className="ok-t">+{som(b.amount_minor)}</b></div>)}</div>
        )}
      </section>

      <section id="jarima" className="rail">
        <h2>⚠️ Jarimalar</h2>
        {d.penalty_reasons.length > 0 && (
          <div className="card small"><b>Qoidalar — jarima qaysi holatlarda:</b>
            <ul>{d.penalty_reasons.map((r: any, i: number) => <li key={i}>{r.name}{r.default_amount_minor ? ` — ${som(r.default_amount_minor)}` : ''}{r.description ? <div className="muted">{r.description}</div> : null}</li>)}</ul>
          </div>
        )}
        {d.penalties.length === 0 ? <p className="muted small" style={{ marginTop: 8 }}>Sizda jarima yo‘q 👍</p> : (
          <div className="slist">{d.penalties.map((p: any) => (
            <div key={p.id} className="scard">
              <div className="spread"><b>{p.reason_text}</b><b className={p.status === 'cancelled' ? 'muted' : 'no-t'}>{p.status === 'cancelled' ? <s>−{som(p.amount_minor)}</s> : `−${som(p.amount_minor)}`}</b></div>
              <div className="muted small">{fmtDate(p.created_at)}{p.note ? ` · ${p.note}` : ''}{p.status === 'cancelled' ? ` · bekor qilindi: ${p.cancel_reason}` : ''}</div>
            </div>
          ))}</div>
        )}
      </section>

      <section id="hayriya" className="rail">
        <h2>💝 Hayriya qutisi</h2>
        <div className="kpi-row">
          <div className="card kpi"><span className="muted">Jami yig‘ildi</span><b>{som(d.charity.total)}</b></div>
          <div className="card kpi"><span className="muted">Egasiga topshirildi</span><b>{som(d.charity.handed)}</b></div>
          <div className="card kpi"><span className="muted">Sizning hissangiz</span><b>{som(d.charity.mine)}</b></div>
        </div>
        <form className="card" style={{ marginTop: 10 }} onSubmit={async (e) => {
          e.preventDefault(); setMsg(null);
          try { await api('/partner/charity', { method: 'POST', idem: crypto.randomUUID(), body: { amount_minor: String(BigInt(amt || '0') * 100n) } }); setMsg('Rahmat! Hissangiz qutiga qo‘shildi 💝'); setAmt(''); void load(); }
          catch (x: any) { setMsg(x.code === 'INSUFFICIENT_AVAILABLE' ? '«Yechish mumkin» balansingizda yetarli mablag‘ yo‘q.' : x.code); }
        }}>
          <label htmlFor="ch-amt">Balansdan xayriya qilish (so‘m)</label>
          <div className="row"><input id="ch-amt" inputMode="numeric" value={amt} onChange={(e) => setAmt(e.target.value.replace(/\D/g, ''))} style={{ flex: 1 }} /><button className="btn" disabled={!amt}>Xayriya qilish</button></div>
          <p className="muted small">Mablag‘ «Yechish mumkin» balansingizdan olinadi. Yig‘ilgan pul kimga topshirilgani pastda ochiq ko‘rsatiladi.</p>
          {msg && <div className="notice" role="status">{msg}</div>}
        </form>
        {d.charity.handovers.length > 0 && <div className="slist" style={{ marginTop: 10 }}>{d.charity.handovers.map((h: any, i: number) => <div key={i} className="scard spread"><div><b>{h.recipient}</b><div className="muted small">{fmtDate(h.created_at)}{h.note ? ` · ${h.note}` : ''}</div></div><b>{som(h.amount_minor)}</b></div>)}</div>}
      </section>
    </>
  );
}

function ContestCard({ c }: { c: any }) {
  return (
    <article className="scard contest">
      <div className="spread"><h3>{c.title}</h3><span className={`pill ${c.status === 'active' ? 'b-delivered' : 'b-cancelled'}`}>{c.status === 'active' ? left(c.ends_at) : 'yakunlangan'}</span></div>
      {c.description && (c.description.length > 160 ? <details className="clamp-more"><summary><span className="small clamp-3">{c.description}</span><span className="link-btn small">Shartlarni o‘qish ▾</span></summary><p className="small" style={{ margin: 0 }}>{c.description}</p></details> : <p className="small" style={{ margin: 0 }}>{c.description}</p>)}
      <div className="muted small">{fmtDate(c.starts_at)} — {fmtDate(c.ends_at)} · {c.metric === 'delivered_sales' ? 'yetkazilgan savdo summasi' : 'yetkazilgan buyurtmalar soni'} bo‘yicha{c.min_delivered > 1 ? ` · kamida ${c.min_delivered} ta` : ''}</div>
      {c.prizes?.length > 0 && <div className="pills">{c.prizes.map((p: any) => <span key={p.place} className="pill b-accepted">{medal(p.place)} {p.text ?? ''}{p.amount_minor ? `${p.text ? ' + ' : ''}${som(p.amount_minor)}` : ''}</span>)}</div>}
      {c.me ? <div className="rank-card"><div className="rank-badge">#{c.me.rank}</div><div><b>Sizning o‘rningiz</b><div className="muted small">{c.metric === 'delivered_sales' ? som(c.me.score) : `${c.me.delivered} ta yetkazilgan`}</div></div></div> : <p className="muted small">Hali reytingda emassiz — birinchi yetkazilgan buyurtmadan keyin chiqasiz.</p>}
      {c.top?.length > 0 && <Podium boxLabel={c.metric === 'delivered_sales' ? 'Savdo' : 'Yetkazildi'} rows={c.top.map((r: any) => ({ rank: r.rank, name: r.name, value: c.metric === 'delivered_sales' ? som(r.score) : `${r.delivered} ta`, num: Number(c.metric === 'delivered_sales' ? r.score : r.delivered), me: r.me, avatar: r.avatar }))} />}
    </article>
  );
}
