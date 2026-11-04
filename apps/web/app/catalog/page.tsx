'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { CategoryIcon } from '@/components/Icons';
import { ProductCard, SkeletonGrid } from '@/components/ProductCard';
import { api } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';
import { errText } from '@/lib/errors';

const PAGE = 24;
const PRICE_CAPS: [string, string][] = [['100000', '100 000 gacha'], ['300000', '300 000 gacha'], ['1000000', '1 mln gacha']];

/**
 * Catalog / search results in marketplace style: photo category chips, one-tap sort chips, price caps,
 * a sticky filter bar and an endless list (next page loads near the end).
 */
function Catalog() {
  const { t, lang } = useI18n();
  const sp = useSearchParams();
  const router = useRouter();
  const q = sp.get('q') ?? '';
  const category = sp.get('category') ?? '';
  const sort = sp.get('sort') ?? (q ? 'popular' : 'new');
  const inStock = sp.get('in_stock') === '1';
  const maxPrice = sp.get('max_price') ?? '';
  const [cats, setCats] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [end, setEnd] = useState(false);
  const [error, setError] = useState<any>(null);
  const [eta, setEta] = useState<string | null>(null);
  const busy = useRef(false);
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api('/categories').then((c) => setCats(c.items)).catch(() => {});
    api('/delivery-zones').then((r) => { const z = r.items ?? []; if (z.length) { const a = Math.min(...z.map((x: any) => x.eta_min_days)), b = Math.max(...z.map((x: any) => x.eta_max_days)); setEta(a === b ? `${a}` : `${a}–${b}`); } }).catch(() => {});
  }, []);
  const qs = useCallback((offset: number) => {
    const p = new URLSearchParams({ limit: String(PAGE), offset: String(offset), sort });
    if (q) p.set('q', q);
    if (category) p.set('category', category);
    if (inStock) p.set('in_stock', 'true');
    if (/^\d+$/.test(maxPrice)) p.set('max_price', maxPrice);
    return p.toString();
  }, [q, category, sort, inStock, maxPrice]);
  const load = () => {
    setLoading(true); setError(null); setEnd(false);
    api(`/products?${qs(0)}`).then((r) => { setItems(r.items); setEnd(r.items.length < PAGE); }).catch(setError).finally(() => setLoading(false));
  };
  useEffect(load, [qs]); // eslint-disable-line react-hooks/exhaustive-deps
  const next = useCallback(async () => {
    if (busy.current || end || loading) return;
    busy.current = true; setMore(true);
    try {
      const r = await api(`/products?${qs(items.length)}`);
      setItems((x) => { const seen = new Set(x.map((i) => i.id)); return [...x, ...r.items.filter((i: any) => !seen.has(i.id))]; });
      if (r.items.length < PAGE) setEnd(true);
    } catch { setEnd(true); } finally { busy.current = false; setMore(false); }
  }, [qs, items.length, end, loading]);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => { if (e[0]?.isIntersecting) void next(); }, { rootMargin: '700px' });
    io.observe(el);
    return () => io.disconnect();
  }, [next]);

  const go = (patch: Record<string, string | null>) => {
    const n = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) { if (v) n.set(k, v); else n.delete(k); }
    router.push(`/catalog${n.toString() ? `?${n}` : ''}`);
  };
  const current = cats.find((c) => c.slug === category);
  const title = q ? `“${q}” ${t('resultsFor')}` : current ? pick(current.name, lang) : t('catalog');
  const sorts: [string, string][] = [['popular', `⭐ ${t('chipHits')}`], ['new', t('sortNew')], ['price_asc', t('sortCheap')], ['price_desc', t('sortExpensive')], ['discount', `🔥 ${t('chipDeals')}`]];

  return (
    <div className="catalog2">
      <nav className="crumbs" aria-label="breadcrumb"><Link href="/">{t('home')}</Link><span>/</span><span>{t('catalog')}</span></nav>
      <h1>{title}</h1>
      <div className="cat-chips" role="list">
        <button role="listitem" className={`cchip ${!category ? 'on' : ''}`} onClick={() => go({ category: null })}><span className="cc-ico">🛍️</span>{t('allCategories')}</button>
        {cats.map((c) => (
          <button role="listitem" key={c.id} className={`cchip ${category === c.slug ? 'on' : ''}`} onClick={() => go({ category: c.slug })}>
            {c.cover ? <img src={c.cover} alt="" /> : <span className="cc-ico"><CategoryIcon slug={c.slug} size={18} /></span>}{pick(c.name, lang)}
          </button>
        ))}
      </div>
      <div className="filter-bar">
        <div className="sort-chips" role="group" aria-label={t('sort')}>
          {sorts.map(([k, l]) => <button key={k} className={`schip ${sort === k ? 'on' : ''}`} aria-pressed={sort === k} onClick={() => go({ sort: k })}>{l}</button>)}
        </div>
        <div className="sort-chips" role="group" aria-label="Narx">
          {PRICE_CAPS.map(([v, l]) => <button key={v} className={`schip ${maxPrice === v ? 'on' : ''}`} aria-pressed={maxPrice === v} onClick={() => go({ max_price: maxPrice === v ? null : v })}>{l}</button>)}
          <button className={`schip ${inStock ? 'on' : ''}`} aria-pressed={inStock} onClick={() => go({ in_stock: inStock ? null : '1' })}>✓ {t('inStockOnly')}</button>
        </div>
      </div>
      <div className="muted small result-count">{loading ? '…' : `${items.length}${end ? '' : '+'} ${t('results')}`}</div>
      {error ? <div role="alert" className="notice">{errText(error)} <button className="btn secondary" onClick={load}>{t('retry')}</button></div>
        : loading ? <SkeletonGrid />
        : items.length === 0 ? <div className="empty"><p>{t('empty')}</p><Link className="btn secondary" href="/catalog">{t('allCategories')}</Link></div>
        : <div className="pgrid">{items.map((p) => <ProductCard key={p.id} p={p} eta={eta} />)}</div>}
      {!loading && items.length > 0 && <div ref={sentinel} className="feed-end" role="status">{more ? t('loadingMore') : end ? t('endOfFeed') : ''}</div>}
    </div>
  );
}

export default function CatalogPage() {
  return <Suspense fallback={<SkeletonGrid />}><Catalog /></Suspense>;
}
