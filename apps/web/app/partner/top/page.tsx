'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Chips, TelegramConnect } from '../shared';
import { errText } from '@/lib/errors';
import { Podium } from '@/components/Podium';

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
      {data && data.items.length === 0 && <div className="empty">Bu davrda hali natija yo‘q — birinchi bo‘ling!</div>}
      {data && data.items.length > 0 && <Podium boxLabel="Yetkazilgan" rows={data.items.map((r: any) => ({ rank: r.rank, name: r.name, value: String(r.delivered), num: r.delivered, sub: `${r.total} ta buyurtma`, me: r.me, avatar: r.avatar }))} />}
      <p className="muted small">Reyting yetkazilgan buyurtmalar soni bo‘yicha. Konkurs va sovrinlar egasi tomonidan e’lon qilinadi.</p>
    </>
  );
}
