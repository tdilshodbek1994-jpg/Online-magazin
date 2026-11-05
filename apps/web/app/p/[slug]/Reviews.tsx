'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

const stars = (n: number) => '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n);

/** Verified-purchase reviews (published after moderation). Shown only when there is at least one. */
export function Reviews({ productId }: { productId: string }) {
  const [d, setD] = useState<any>(null);
  useEffect(() => { api(`/products/${productId}/reviews`).then(setD).catch(() => {}); }, [productId]);
  if (!d || d.count === 0) return null;
  return (
    <section className="card rv">
      <div className="dec-head"><h2>Sharhlar</h2><span className="rv-avg"><b>{d.average}</b> <span className="rv-st">{stars(Math.round(Number(d.average)))}</span> <small className="muted">({d.count})</small></span></div>
      {d.items.map((r: any, i: number) => (
        <div key={i} className="rv-item">
          <div className="spread small"><span className="rv-st">{stars(r.rating)}</span><span className="muted">{r.author} · ✓ sotib olgan · {new Date(r.created_at).toLocaleDateString('uz-UZ')}</span></div>
          {r.body && <p>{r.body}</p>}
        </div>
      ))}
    </section>
  );
}
