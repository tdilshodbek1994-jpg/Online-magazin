'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Chips, TelegramConnect } from '../shared';
import { errText } from '@/lib/errors';

export default function PartnerTop() {
  const [period, setPeriod] = useState('month');
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  useEffect(() => { setErr(null); api(`/partner/leaderboard?period=${period}`).then(setData).catch(setErr); }, [period]);
  const medal = (r: number) => (r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : `#${r}`);
  return (
    <>
      <h1>TOP va holatim</h1>
      {/* One folder for the 3 small facts that used to sit on the dashboard: Telegram, day admin, month rank. */}
      <TelegramConnect />
      <Chips items={[['today', 'Bugun'], ['week', 'Hafta'], ['month', 'Shu oy']]} value={period} onChange={setPeriod} label="Davr" />
      {err && <div className="notice" role="alert">{errText(err)}</div>}
      {data?.me && <div className="rank-card"><div className="rank-badge">#{data.me.rank}</div><div><b>Sizning o‘rningiz</b><div className="muted">{data.me.delivered} ta yetkazilgan</div></div></div>}
      {data && data.items.length === 0 && <div className="empty">Bu davrda hali natija yo‘q — birinchi bo‘ling!</div>}
      <ol className="top-list">
        {data?.items.map((r: any) => (
          <li key={`${r.rank}-${r.name}`} className={r.me ? 'me' : ''}>
            <span className="top-rank">{medal(r.rank)}</span>
            <span className="top-name">{r.name}{r.me ? ' (siz)' : ''}</span>
            <span className="top-val"><b>{r.delivered}</b> <span className="muted small">yetkazilgan / {r.total}</span></span>
          </li>
        ))}
      </ol>
      <p className="muted small">Reyting yetkazilgan buyurtmalar soni bo‘yicha. Konkurs va sovrinlar egasi tomonidan e’lon qilinadi.</p>
    </>
  );
}
