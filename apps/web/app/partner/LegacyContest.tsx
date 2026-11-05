'use client';
import { Podium } from '@/components/Podium';
import { som } from '@/lib/api';
import { useState } from 'react';

const MONTHS = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];
export const fmtDate = (d: string) => { const x = new Date(new Date(d).getTime() + 5 * 3600000); return `${x.getUTCDate()}-${MONTHS[x.getUTCMonth()]}`; };
export const left = (d: string) => { const ms = new Date(d).getTime() - Date.now(); if (ms <= 0) return 'tugadi'; const days = Math.floor(ms / 86400000); const h = Math.floor((ms % 86400000) / 3600000); return days ? `${days} kun ${h} soat qoldi` : `${h} soat qoldi`; };
const medal = (r: number) => (r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : `#${r}`);


/** Contest from the earlier simple contest section (shown inside Konkurs markazi). */
export function ContestCard({ c }: { c: any }) {
  return (
    <article className="scard contest">
      <div className="spread"><h3>{c.title}</h3><span className={`pill ${c.status === 'active' ? 'b-delivered' : 'b-cancelled'}`}>{c.status === 'active' ? left(c.ends_at) : 'yakunlangan'}</span></div>
      {c.description && <Rules text={c.description} />}
      <div className="muted small">{fmtDate(c.starts_at)} — {fmtDate(c.ends_at)} · {c.metric === 'delivered_sales' ? 'yetkazilgan savdo summasi' : 'yetkazilgan buyurtmalar soni'} bo‘yicha{c.min_delivered > 1 ? ` · kamida ${c.min_delivered} ta` : ''}</div>
      {c.prizes?.length > 0 && <div className="pills">{c.prizes.map((p: any) => <span key={p.place} className="pill b-accepted">{medal(p.place)} {p.text ?? ''}{p.amount_minor ? `${p.text ? ' + ' : ''}${som(p.amount_minor)}` : ''}</span>)}</div>}
      {c.me ? <div className="rank-card"><div className="rank-badge">#{c.me.rank}</div><div><b>Sizning o‘rningiz</b><div className="muted small">{c.metric === 'delivered_sales' ? som(c.me.score) : `${c.me.delivered} ta yetkazilgan`}</div></div></div> : <p className="muted small">Hali reytingda emassiz — birinchi yetkazilgan buyurtmadan keyin chiqasiz.</p>}
      {c.top?.length > 0 && <Podium boxLabel={c.metric === 'delivered_sales' ? 'Savdo' : 'Yetkazildi'} rows={c.top.map((r: any) => ({ rank: r.rank, name: r.name, value: c.metric === 'delivered_sales' ? som(r.score) : `${r.delivered} ta`, num: Number(c.metric === 'delivered_sales' ? r.score : r.delivered), me: r.me, avatar: r.avatar }))} />}
    </article>
  );
}

/** Contest rules keep the owner's line breaks and numbering; long text is folded to a few lines with a toggle. */
export function Rules({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  // "… savdo. 1. Barcha … 2. Shaxsiy …" written on one line → put numbered points and emoji headers on their own lines
  const pretty = text.replace(/\s+(?=(\d{1,2}[.)]\s))/g, '\n').replace(/\s+(?=[📅🎯✅🏆🎁⚠️🔥💰📌👉])/gu, '\n').trim();
  const long = pretty.length > 220 || pretty.split('\n').length > 4;
  return (
    <div className="rules">
      <p className={`rules-t ${long && !open ? 'clamp' : ''}`}>{pretty}</p>
      {long && <button type="button" className="link-btn small" onClick={() => setOpen(!open)}>{open ? 'Yig‘ish ▴' : 'Shartlarni to‘liq o‘qish ▾'}</button>}
    </div>
  );
}
