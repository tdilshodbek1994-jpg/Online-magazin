'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ProductCard } from '@/components/ProductCard';
import { loadCards } from '@/components/SavedRails';
import { useFavs } from '@/lib/favs';

/** "Sevimlilar": products saved with the heart on this device; prices and stock are loaded fresh. */
export default function Favorites() {
  const favs = useFavs();
  const [items, setItems] = useState<any[] | null>(null);
  const key = favs.map((f) => f.id).join(',');
  useEffect(() => { if (!favs.length) { setItems([]); return; } loadCards(favs).then(setItems); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = (items ?? []).filter((p) => favs.some((f) => f.id === p.id));
  return (
    <div>
      <h1>Sevimlilar {favs.length > 0 && <span className="muted">· {favs.length}</span>}</h1>
      <p className="muted small">Yurakcha bosilgan mahsulotlar shu qurilmada saqlanadi. Narx va mavjudlik har safar yangilanadi.</p>
      {items === null ? <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>
        : shown.length === 0 ? (
          <div className="empty"><p style={{ fontSize: 40, margin: 0 }} aria-hidden>🤍</p><p>Hali sevimli mahsulot yo‘q. Mahsulot kartochkasidagi yurakchani bosing.</p><Link className="btn" href="/catalog">Katalogga o‘tish</Link></div>
        ) : <div className="pgrid">{shown.map((p) => <ProductCard key={p.id} p={p} />)}</div>}
    </div>
  );
}
