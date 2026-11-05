'use client';
import { toggleFav, useFavs } from '@/lib/favs';

/** Heart toggle. Rendered as a sibling of the card link (never nested inside it) so it stays a valid, focusable button. */
export function FavButton({ id, slug, name, big = false }: { id: string; slug: string; name: string; big?: boolean }) {
  const favs = useFavs();
  const on = favs.some((f) => f.id === id);
  return (
    <button type="button" className={`fav-btn ${on ? 'on' : ''} ${big ? 'big' : ''}`} aria-pressed={on}
      aria-label={on ? `${name}: sevimlilardan olib tashlash` : `${name}: sevimlilarga qo‘shish`}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleFav({ id, slug }); }}>
      <svg viewBox="0 0 24 24" width={big ? 24 : 20} height={big ? 24 : 20} aria-hidden="true">
        <path d="M12 21s-7.5-4.6-9.5-9.2C1.1 8.4 3.3 5 6.8 5c2 0 3.4 1.1 4.2 2.4h2c.8-1.3 2.2-2.4 4.2-2.4 3.5 0 5.7 3.4 4.3 6.8C19.5 16.4 12 21 12 21z" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      </svg>
    </button>
  );
}
