'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, som } from '@/lib/api';
import { errText } from '@/lib/errors';

import { fmtDate, left } from '../LegacyContest';

export default function PartnerPrograms() {
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const load = () => api('/partner/programs').then(setD).catch(setErr);
  useEffect(() => { void load(); }, []);
  if (err) return <div className="notice" role="alert">{errText(err)}</div>;
  if (!d) return <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>;
  return (
    <>
      <h1>Bonus va jarimalar</h1>
      <div className="hub-links">
        <Link href="/partner/contests" className="hub-link">🏆 <span>Konkurslar</span><small>Konkurs markazi ›</small></Link>
        <Link href="/partner/charity" className="hub-link">💝 <span>Xayriya</span><small>Xayriya markazi ›</small></Link>
        <Link href="/partner/level" className="hub-link">🎖️ <span>Darajam</span><small>daraja va kupon ›</small></Link>
        <Link href="/partner/uzcoin" className="hub-link">🪙 <span>UzCoin</span><small>tanga va sovg‘alar ›</small></Link>
      </div>

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

    </>
  );
}

