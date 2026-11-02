'use client';
import { useEffect, useState } from 'react';
import { ProductCard } from '@/components/ProductCard';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

export function Related({ category, exclude }: { category: string; exclude: string }) {
  const { t } = useI18n();
  const [items, setItems] = useState<any[]>([]);
  useEffect(() => {
    api(`/products?limit=9&category=${encodeURIComponent(category)}`).then((r) => setItems(r.items.filter((p: any) => p.slug !== exclude).slice(0, 8))).catch(() => {});
  }, [category, exclude]);
  if (items.length === 0) return null;
  return (
    <section className="rail">
      <div className="rail-head"><h2>{t('related')}</h2></div>
      <div className="pgrid">{items.map((p) => <ProductCard key={p.id} p={p} />)}</div>
    </section>
  );
}
