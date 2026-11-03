'use client';
import { useEffect, useState } from 'react';
import { ProductCard } from '@/components/ProductCard';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

/** Keep the shopper browsing: best sellers of this category (real sales) + similar products. */
export function Related({ category, exclude }: { category: string; exclude: string }) {
  const { t } = useI18n();
  const [items, setItems] = useState<any[]>([]);
  const [hits, setHits] = useState<any[]>([]);
  useEffect(() => {
    const c = encodeURIComponent(category);
    api(`/products?limit=9&category=${c}`).then((r) => setItems(r.items.filter((p: any) => p.slug !== exclude).slice(0, 8))).catch(() => {});
    api(`/products?limit=12&sort=popular&in_stock=true&category=${c}`).then((r) => setHits(r.items.filter((p: any) => p.slug !== exclude && Number(p.sold_30d) > 0))).catch(() => {});
  }, [category, exclude]);
  return (
    <>
      {hits.length > 0 && (
        <section className="sec">
          <div className="sec-head"><h2><span className="sec-badge">{t('hitBadge')}</span>Shu toifada ko‘p sotilganlar</h2></div>
          <div className="hrail">{hits.map((p) => <ProductCard key={p.id} p={p} compact />)}</div>
        </section>
      )}
      {items.length > 0 && (
        <section className="sec">
          <div className="sec-head"><h2>{t('related')}</h2></div>
          <div className="pgrid">{items.map((p) => <ProductCard key={p.id} p={p} />)}</div>
        </section>
      )}
    </>
  );
}
