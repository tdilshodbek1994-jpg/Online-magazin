'use client';
import Link from 'next/link';
import { som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';
import { FavButton } from '@/components/FavButton';

export function discountPct(price?: string | null, was?: string | null): number {
  if (!price || !was) return 0;
  const p = Number(price), w = Number(was);
  return w > p ? Math.round((1 - p / w) * 100) : 0;
}

const NEW_DAYS = 14;

/**
 * Marketplace card (dense, price-first). Every signal comes from real data:
 * discount = catalog compare-at price, "N ta sotildi" = confirmed orders in 30 days, "Kam qoldi" = real stock.
 * No invented ratings or timers.
 */
export function ProductCard({ p, eta, compact = false }: { p: any; eta?: string | null; compact?: boolean }) {
  const { t, lang } = useI18n();
  const price = p.min_price?.amount_minor;
  const was = p.compare_at?.amount_minor;
  const off = discountPct(price, was);
  const name = pick(p.name, lang);
  const sold = Number(p.sold_30d ?? 0);
  const isNew = p.published_at && Date.now() - new Date(p.published_at).getTime() < NEW_DAYS * 86400_000;
  const out = !(p.available > 0);
  return (
    <div className={`pcard-wrap ${compact ? 'compact' : ''}`}>
    <Link href={`/p/${p.slug}`} className={`pcard ${compact ? 'compact' : ''} ${out ? 'is-out' : ''}`}>
      <div className="pcard-img">
        {p.image ? <img src={p.image} alt={name} loading="lazy" width={320} height={320} /> : <div className="ph" aria-hidden />}
        <div className="pbadges">
          {off > 0 && <span className="b-off">−{off}%</span>}
          {sold >= 5 && <span className="b-hit">{t('hitBadge')}</span>}
          {isNew && !off && <span className="b-new">{t('newBadge')}</span>}
        </div>
        {out && <span className="b-out">{t('outOfStock')}</span>}
      </div>
      <div className="pcard-body">
        <div className="price-row">
          <span className={`price ${off ? 'is-deal' : ''}`}>{som(price)}</span>
        </div>
        {off > 0 && <div className="was-row"><s className="was">{som(was)}</s><span className="off-t">−{off}%</span></div>}
        <div className="pname">{name}</div>
        {(sold > 0 || (!out && p.available <= 5)) && (
          <div className="pmeta">
            {sold > 0 && <span className="sold-chip">🔥 {sold} {t('sold')}</span>}
            {!out && p.available <= 5 && <span className="few-t">{t('fewLeft')}: {p.available} {t('pcs')}</span>}
          </div>
        )}
        {!compact && !out && eta && <div className="ship-t">🚚 {eta} {t('deliveryLine')} · {t('codShort')}</div>}
      </div>
    </Link>
    {p.id && <FavButton id={p.id} slug={p.slug} name={name} />}
    </div>
  );
}

export function SkeletonGrid({ n = 8 }: { n?: number }) {
  return <div className="pgrid" aria-hidden>{Array.from({ length: n }, (_, i) => <div key={i} className="pcard sk"><div className="pcard-img" /><div className="pcard-body"><div className="sk-line" /><div className="sk-line short" /></div></div>)}</div>;
}
