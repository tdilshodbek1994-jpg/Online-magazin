'use client';
import { useEffect, useState } from 'react';
import { ProductCard } from '@/components/ProductCard';
import { api } from '@/lib/api';
import { getRecent } from '@/lib/favs';

/** Turns a product detail response into the list-card shape (fresh price and stock every time). */
export function toCard(p: any) {
  const v: any[] = p.variants ?? [];
  const min = v.reduce((m: any, x: any) => (!m || BigInt(x.price_minor) < BigInt(m.price_minor) ? x : m), null);
  const was = v.map((x) => x.compare_at_minor).filter(Boolean).sort((a: string, b: string) => (BigInt(b) > BigInt(a) ? 1 : -1))[0];
  return { id: p.id, slug: p.slug, name: p.name, image: p.media?.[0]?.url ?? null, min_price: min ? { amount_minor: min.price_minor } : null, compare_at: was ? { amount_minor: was } : null,
    available: v.reduce((a, x) => a + Number(x.available ?? 0), 0), sold_30d: p.sold_30d ?? 0 };
}

export async function loadCards(items: { slug: string }[]): Promise<any[]> {
  const res = await Promise.all(items.slice(0, 24).map((i) => api(`/products/${encodeURIComponent(i.slug)}`).then((p) => (p?.id && !p.redirect ? toCard(p) : null)).catch(() => null)));
  return res.filter(Boolean);
}

/** "Yaqinda ko‘rganlaringiz" — only when this device has history; hidden otherwise. */
export function RecentRail({ exclude }: { exclude?: string }) {
  const [items, setItems] = useState<any[]>([]);
  useEffect(() => { const r = getRecent().filter((x) => x.id !== exclude); if (r.length) loadCards(r.slice(0, 10)).then(setItems); }, [exclude]);
  if (items.length < 2) return null;
  return (
    <section className="sec">
      <div className="sec-head"><h2>Yaqinda ko‘rganlaringiz</h2></div>
      <div className="hrail">{items.map((p) => <ProductCard key={p.id} p={p} compact />)}</div>
    </section>
  );
}
