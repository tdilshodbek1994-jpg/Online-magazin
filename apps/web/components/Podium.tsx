'use client';

export interface PodiumRow { rank: number | null; name: string; value: string; num?: number; sub?: string; me?: boolean; avatar?: string | null }

/** Profile photo if the partner set one, otherwise the plain UzShop mark. */
function Ava({ src, cls = '' }: { src?: string | null; cls?: string }) {
  return src ? <img className={`t3-ava ${cls}`} src={src} alt="" loading="lazy" /> : <span className={`t3-ava t3-ava-def ${cls}`} aria-hidden><img src="/icons/icon-192.png" alt="" /></span>;
}

/**
 * "TOP 3" leaderboard: dark starry stage, silver · gold · bronze glass cards with ring avatars and rank badges,
 * then "my place" bar with progress to the leader, then the rest. Only real ranks — never invented winners or photos.
 */
export function Podium({ rows, boxLabel = 'Natija' }: { rows: PodiumRow[]; boxLabel?: string; unit?: string }) {
  const ranked = rows.filter((r) => r.rank !== null);
  if (!ranked.length) return <p className="muted small">Hali natija yo‘q — birinchi bo‘ling!</p>;
  const top = ranked.filter((r) => (r.rank ?? 99) <= 3).slice(0, 3);
  const rest = ranked.filter((r) => !top.includes(r));
  const order = [top.find((r) => r.rank === 2) ?? top[1], top.find((r) => r.rank === 1) ?? top[0], top.find((r) => r.rank === 3) ?? top[2]];
  const me = ranked.find((r) => r.me);
  const leader = Math.max(...ranked.map((r) => r.num ?? 0), 0);
  const tone = (n: number | null) => (n === 1 ? 'gold' : n === 2 ? 'silver' : 'bronze');
  return (
    <div className="t3">
      <div className="t3-stage">
        <div className="t3-title"><span className="t3-laurel" aria-hidden>✨</span>TOP 3<span className="t3-laurel r" aria-hidden>✨</span></div>
        <div className="t3-cards" role="list" aria-label="Eng yaxshi uchtalik">
          {order.map((r, i) => r ? (
            <div key={`${r.rank}-${r.name}`} role="listitem" className={`t3-card t3-${tone(r.rank)} ${r.me ? 't3-me' : ''}`} style={{ order: i }}>
              {r.rank === 1 && <span className="t3-crown" aria-hidden>👑</span>}
              <div className="t3-ring"><Ava src={r.avatar} /><span className="t3-badge" aria-label={`${r.rank}-o‘rin`}>{r.rank}</span></div>
              <b className="t3-name">{r.name}{r.me ? ' (siz)' : ''}</b>
              {r.sub && <span className="t3-sub">{r.sub}</span>}
              <div className="t3-box"><span>{boxLabel}</span><b>{r.value}</b></div>
            </div>
          ) : <div key={`e${i}`} className="t3-card t3-empty" style={{ order: i }} aria-hidden />)}
        </div>
        {me && (
          <div className="t3-mine" aria-label="Mening o‘rnim">
            <span className="t3-mine-rank"><span aria-hidden>👑</span>{me.rank}</span>
            <Ava src={me.avatar} cls="sm" />
            <div className="t3-mine-mid"><b>{me.name} (siz)</b><div className="t3-bar"><i style={{ width: `${leader ? Math.max(4, Math.round(((me.num ?? 0) / leader) * 100)) : 0}%` }} /></div></div>
            <b className="t3-mine-val">{me.value}</b>
          </div>
        )}
      </div>
      {rest.length > 0 && (
        <ol className="pod-rest">
          {rest.map((r) => <li key={`${r.rank}-${r.name}`} className={r.me ? 'me' : ''}><span className="pr-rank">#{r.rank}</span><Ava src={r.avatar} cls="xs" /><span className="pr-name">{r.name}{r.me ? ' (siz)' : ''}</span><b>{r.value}</b></li>)}
        </ol>
      )}
    </div>
  );
}
