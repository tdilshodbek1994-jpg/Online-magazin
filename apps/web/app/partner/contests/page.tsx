'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, som } from '@/lib/api';
import { errText } from '@/lib/errors';
import { dt, METRIC_UZ, STATUS_UZ } from './shared';

/** Konkurs markazi: active / upcoming / finished contests. Joining is voluntary and never changes normal commission. */
export default function ContestCenter() {
  const [items, setItems] = useState<any[] | null>(null);
  const [prizes, setPrizes] = useState<any[]>([]);
  const [err, setErr] = useState<any>(null);
  useEffect(() => {
    api('/partner/cc/contests').then((r) => setItems(r.items)).catch(setErr);
    api('/partner/cc/prizes').then((r) => setPrizes(r.items)).catch(() => {});
  }, []);
  const groups: [string, string[]][] = [['Davom etmoqda', ['active']], ['Tez orada', ['scheduled']], ['Natija kutilmoqda', ['calculating', 'provisional', 'appeal_window', 'paused']], ['Yakunlangan', ['finalized', 'awarded', 'canceled']]];
  return (
    <div className="cc">
      <h1>Konkurs markazi</h1>
      <p className="muted small">Qatnashish bepul va ixtiyoriy. Natija faqat yetkazilgan va to‘lovi tasdiqlangan haqiqiy buyurtmalardan hisoblanadi. Qatnashmasangiz ham oddiy komissiyangiz o‘zgarmaydi.</p>
      {err && <div className="notice" role="alert">{errText(err)}</div>}
      {items === null && !err && <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>}
      {items?.length === 0 && <div className="empty">Hozircha konkurs yo‘q.</div>}
      {groups.map(([title, sts]) => {
        const list = (items ?? []).filter((c) => sts.includes(c.status));
        if (!list.length) return null;
        return (
          <section key={title}>
            <h2 className="an-h2">{title}</h2>
            <div className="slist">
              {list.map((c) => (
                <Link key={c.id} href={`/partner/contests/${c.id}`} className="scard cc-card">
                  <div className="spread"><b>{c.title_latn}</b><span className={`pill ${STATUS_UZ[c.status]?.[1] ?? ''}`}>{STATUS_UZ[c.status]?.[0] ?? c.status}</span></div>
                  <div className="small muted">{dt(c.starts_at)} — {dt(c.ends_at)} · {METRIC_UZ[c.metric]}</div>
                  {c.prizes?.length > 0 && <div className="small">🏆 {c.prizes.slice(0, 3).map((p: any) => `${p.place ? `${p.place}-o‘rin` : p.nomination ?? 'Nominatsiya'}: ${p.title}${p.kind === 'money' && p.value_minor !== '0' ? ` (${som(p.value_minor)})` : ''}`).join(' · ')}</div>}
                  <div className="small">{c.joined ? <span className="ok-t">✓ Siz qatnashyapsiz</span> : ['active', 'scheduled'].includes(c.status) ? <span className="w-link">Shartlarni ko‘rish va qo‘shilish ›</span> : <span className="muted">Natijalarni ko‘rish ›</span>}</div>
                </Link>
              ))}
            </div>
          </section>
        );
      })}
      {prizes.length > 0 && (
        <section>
          <h2 className="an-h2">Mening sovrinlarim</h2>
          {prizes.map((p) => <div key={p.id} className="spread small w-prod"><span>{p.contest} · {p.title}{p.kind === 'money' ? ` (${som(p.value_minor)})` : ''}</span><b>{({ assigned: 'Ajratildi', paid: 'Hisobingizga o‘tkazildi', claimed: 'Qabul qilindi', shipped: 'Yo‘lda', delivered: 'Topshirildi', expired: 'Muddati o‘tdi' } as Record<string, string>)[p.status] ?? p.status}</b></div>)}
        </section>
      )}
      <p className="small"><Link href="/partner/programs">Bonuslar, jarimalar va hayriya →</Link></p>
    </div>
  );
}
