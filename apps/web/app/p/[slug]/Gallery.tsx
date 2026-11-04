'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';

/**
 * Product gallery: swipe between photos on the main image, tap to open a full-screen viewer (swipe, arrows, Esc,
 * native pinch-zoom on phones, click-to-zoom on desktop). Thumbnails stay for quick jumps.
 */
export function Gallery({ media, name, off, slug }: { media: { id: string; url: string; alt?: Record<string, string> }[]; name: string; off: number; slug?: string }) {
  const [i, setI] = useState(0);
  const [open, setOpen] = useState(false);
  const [zoom, setZoom] = useState(false);
  const [video, setVideo] = useState<string | null>(null);
  const touch = useRef<number | null>(null);
  useEffect(() => { if (slug) api(`/reels?product=${encodeURIComponent(slug)}&limit=1`).then((r) => setVideo(r.items[0]?.id ?? null)).catch(() => {}); }, [slug]);
  const n = media.length;
  const go = (d: number) => { if (n > 1) { setI((x) => (x + d + n) % n); setZoom(false); } };
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); if (e.key === 'ArrowRight') go(1); if (e.key === 'ArrowLeft') go(-1); };
    document.addEventListener('keydown', k);
    const prev = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', k); document.body.style.overflow = prev; };
  }, [open, n]); // eslint-disable-line react-hooks/exhaustive-deps
  const swipe = {
    onTouchStart: (e: React.TouchEvent) => { touch.current = e.touches.length === 1 ? e.touches[0]!.clientX : null; },
    onTouchEnd: (e: React.TouchEvent) => { if (touch.current === null || zoom) return; const dx = e.changedTouches[0]!.clientX - touch.current; if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1); touch.current = null; },
  };
  const cur = media[i];
  const big = (u: string) => u.replace(/-w640\.webp$/, '-w1200.webp');
  return (
    <div className="gallery">
      <div className="g-main" {...swipe}>
        {cur ? (
          <button type="button" className="g-open" onClick={() => setOpen(true)} aria-label={`${name}: rasmni kattalashtirish`}>
            <img src={cur.url} srcSet={`${cur.url} 640w, ${big(cur.url)} 1200w`} sizes="(min-width: 900px) 560px, 100vw" alt={name} width={640} height={640} />
          </button>
        ) : <div className="ph" aria-hidden />}
        {off > 0 && <span className="sale">−{off}%</span>}
        {video && <Link href={`/reels?v=${video}`} className="video-chip">▶ Video sharh</Link>}
        {n > 1 && <span className="g-count" aria-hidden>{i + 1} / {n}</span>}
        {n > 1 && <span className="g-dots" aria-hidden>{media.map((m, k) => <i key={m.id} className={k === i ? 'on' : ''} />)}</span>}
      </div>
      {n > 1 && (
        <div className="g-thumbs">
          {media.map((m, k) => (
            <button key={m.id} className={k === i ? 'on' : ''} onClick={() => setI(k)} aria-label={`${name} ${k + 1}`}>
              <img src={m.url} alt="" width={72} height={72} />
            </button>
          ))}
        </div>
      )}
      {open && cur && (
        <div className="lightbox" role="dialog" aria-modal="true" aria-label={`${name} — rasmlar`} onClick={() => setOpen(false)}>
          <button type="button" className="lb-close" aria-label="Yopish" onClick={() => setOpen(false)}>×</button>
          {n > 1 && <button type="button" className="lb-nav prev" aria-label="Oldingi rasm" onClick={(e) => { e.stopPropagation(); go(-1); }}>‹</button>}
          <div className={`lb-stage ${zoom ? 'zoom' : ''}`} onClick={(e) => e.stopPropagation()} {...swipe}>
            <img src={big(cur.url)} alt={name} onClick={() => setZoom(!zoom)} />
          </div>
          {n > 1 && <button type="button" className="lb-nav next" aria-label="Keyingi rasm" onClick={(e) => { e.stopPropagation(); go(1); }}>›</button>}
          <div className="lb-foot" onClick={(e) => e.stopPropagation()}>{n > 1 ? `${i + 1} / ${n} · ` : ''}{zoom ? 'Kichraytirish uchun bosing' : 'Kattalashtirish uchun bosing'}</div>
        </div>
      )}
    </div>
  );
}
