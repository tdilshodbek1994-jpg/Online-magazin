'use client';
import { useState } from 'react';

export function Gallery({ media, name, off }: { media: { id: string; url: string; alt?: Record<string, string> }[]; name: string; off: number }) {
  const [i, setI] = useState(0);
  const cur = media[i];
  const big = (u: string) => u.replace(/-w640\.webp$/, '-w1200.webp');
  return (
    <div className="gallery">
      <div className="g-main">
        {cur ? <img src={cur.url} srcSet={`${cur.url} 640w, ${big(cur.url)} 1200w`} sizes="(min-width: 900px) 560px, 100vw" alt={name} width={640} height={640} /> : <div className="ph" aria-hidden />}
        {off > 0 && <span className="sale">−{off}%</span>}
      </div>
      {media.length > 1 && (
        <div className="g-thumbs">
          {media.map((m, k) => (
            <button key={m.id} className={k === i ? 'on' : ''} onClick={() => setI(k)} aria-label={`${name} ${k + 1}`}>
              <img src={m.url} alt="" width={72} height={72} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
