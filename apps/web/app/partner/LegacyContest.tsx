'use client';
import { Podium } from '@/components/Podium';
import { som } from '@/lib/api';

const MONTHS = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];
export const fmtDate = (d: string) => { const x = new Date(new Date(d).getTime() + 5 * 3600000); return `${x.getUTCDate()}-${MONTHS[x.getUTCMonth()]}`; };
export const left = (d: string) => { const ms = new Date(d).getTime() - Date.now(); if (ms <= 0) return 'tugadi'; const days = Math.floor(ms / 86400000); const h = Math.floor((ms % 86400000) / 3600000); return days ? `${days} kun ${h} soat qoldi` : `${h} soat qoldi`; };
const medal = (r: number) => (r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : `#${r}`);


/** Contest from the earlier simple contest section (shown inside Konkurs markazi). */
export function ContestCard({ c }: { c: any }) {
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
