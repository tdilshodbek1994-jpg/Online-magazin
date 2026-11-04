'use client';

export interface PodiumRow { rank: number | null; name: string; value: string; me?: boolean }

/** Top-3 podium (2 · 1 · 3), then the rest as a list. Ties share a step; only real ranks are shown — never invented winners. */
export function Podium({ rows, unit }: { rows: PodiumRow[]; unit?: string }) {
  const ranked = rows.filter((r) => r.rank !== null);
  const top = ranked.filter((r) => (r.rank ?? 99) <= 3).slice(0, 3);
  const rest = ranked.filter((r) => !top.includes(r));
  const order = [top.find((r) => r.rank === 2) ?? top[1], top.find((r) => r.rank === 1) ?? top[0], top.find((r) => r.rank === 3) ?? top[2]];
  const medal = (n: number | null) => (n === 1 ? '🥇' : n === 2 ? '🥈' : n === 3 ? '🥉' : `#${n}`);
  const initials = (s: string) => s.replace(/[^\p{L}\p{N} ]/gu, '').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '★';
  if (!ranked.length) return <p className="muted small">Hali natija yo‘q — birinchi bo‘ling!</p>;
  return (
    <div className="podium-wrap">
      <div className="podium" role="list" aria-label="Eng yaxshi uchtalik">
        {order.map((r, i) => r ? (
          <div key={`${r.rank}-${r.name}`} role="listitem" className={`pod pod-${r.rank} ${r.me ? 'pod-me' : ''}`} style={{ order: i }}>
            {r.rank === 1 && <span className="pod-crown" aria-hidden>👑</span>}
            <span className="pod-ava" aria-hidden>{initials(r.name)}</span>
            <b className="pod-name">{r.me ? 'Siz' : r.name}</b>
            <span className="pod-val">{r.value}{unit ? ` ${unit}` : ''}</span>
            <div className="pod-step"><span className="pod-medal" aria-label={`${r.rank}-o‘rin`}>{medal(r.rank)}</span><span className="pod-rank">{r.rank}</span></div>
          </div>
        ) : <div key={`empty-${i}`} className="pod pod-empty" style={{ order: i }} aria-hidden />)}
      </div>
      {rest.length > 0 && (
        <ol className="pod-rest">
          {rest.map((r) => <li key={`${r.rank}-${r.name}`} className={r.me ? 'me' : ''}><span className="pr-rank">#{r.rank}</span><span className="pr-name">{r.me ? 'Siz' : r.name}</span><b>{r.value}{unit ? ` ${unit}` : ''}</b></li>)}
        </ol>
      )}
    </div>
  );
}
