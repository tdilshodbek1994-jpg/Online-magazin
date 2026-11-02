'use client';
import Link from 'next/link';
import { som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';

export function discountPct(price?: string | null, was?: string | null): number {
  if (!price || !was) return 0;
  const p = Number(price), w = Number(was);
  return w > p ? Math.round((1 - p / w) * 100) : 0;
}

export function ProductCard({ p }: { p: any }) {
  const { t, lang } = useI18n();
  const price = p.min_price?.amount_minor;
  const was = p.compare_at?.amount_minor;
  const off = discountPct(price, was);
  const name = pick(p.name, lang);
  return (
    <Link href={`/p/${p.slug}`} className="pcard">
      <div className="pcard-img">
        {p.image ? <img src={p.image} alt={name} loading="lazy" width={320} height={320} /> : <div className="ph" aria-hidden />}
        {off > 0 && <span className="sale">−{off}%</span>}
      </div>
      <div className="pcard-body">
        <div className="price-row">
          <span className="price">{som(price)}</span>
          {off > 0 && <s className="was">{som(was)}</s>}
        </div>
        <div className="pname">{name}</div>
        {p.brand && <div className="pbrand">{p.brand}</div>}
        <div className={p.available > 0 ? 'stock ok-t' : 'stock no-t'}>{p.available > 0 ? t('inStock') : t('outOfStock')}</div>
      </div>
    </Link>
  );
}

export function SkeletonGrid({ n = 8 }: { n?: number }) {
  return <div className="pgrid" aria-hidden>{Array.from({ length: n }, (_, i) => <div key={i} className="pcard sk"><div className="pcard-img" /><div className="pcard-body"><div className="sk-line" /><div className="sk-line short" /></div></div>)}</div>;
}
