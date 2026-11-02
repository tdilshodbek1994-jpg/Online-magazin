'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { CategoryIcon } from '@/components/Icons';
import { ProductCard, SkeletonGrid } from '@/components/ProductCard';
import { api } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';

function Catalog() {
  const { t, lang } = useI18n();
  const sp = useSearchParams();
  const router = useRouter();
  const q = sp.get('q') ?? '';
  const category = sp.get('category') ?? '';
  const sort = sp.get('sort') ?? 'new';
  const inStock = sp.get('in_stock') === '1';
  const [cats, setCats] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);

  useEffect(() => { api('/categories').then((c) => setCats(c.items)).catch(() => {}); }, []);
  const load = () => {
    setLoading(true); setError(null);
    const qs = new URLSearchParams({ limit: '48', sort });
    if (q) qs.set('q', q);
    if (category) qs.set('category', category);
    if (inStock) qs.set('in_stock', 'true');
    api(`/products?${qs}`).then((r) => setItems(r.items)).catch(setError).finally(() => setLoading(false));
  };
  useEffect(load, [q, category, sort, inStock]);

  const go = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
    router.push(`/catalog${next.toString() ? `?${next}` : ''}`);
  };
  const current = cats.find((c) => c.slug === category);
  const title = q ? `“${q}” ${t('resultsFor')}` : current ? pick(current.name, lang) : t('catalog');

  return (
    <>
      <nav className="crumbs" aria-label="breadcrumb"><Link href="/">{t('home')}</Link><span>/</span><span>{t('catalog')}</span></nav>
      <h1>{title}</h1>
      <div className="chips" role="list">
        <button role="listitem" className={`chip ${!category ? 'on' : ''}`} onClick={() => go({ category: null })}>{t('allCategories')}</button>
        {cats.map((c) => (
          <button role="listitem" key={c.id} className={`chip ${category === c.slug ? 'on' : ''}`} onClick={() => go({ category: c.slug })}>
            <CategoryIcon slug={c.slug} size={18} /> {pick(c.name, lang)}
          </button>
        ))}
      </div>
      <div className="toolbar">
        <span className="muted">{loading ? '…' : `${items.length} ${t('results')}`}</span>
        <div className="row">
          <label className="check"><input type="checkbox" checked={inStock} onChange={(e) => go({ in_stock: e.target.checked ? '1' : null })} /> {t('inStockOnly')}</label>
          <label className="sr-only" htmlFor="sort">{t('sort')}</label>
          <select id="sort" value={sort} onChange={(e) => go({ sort: e.target.value })} className="sort">
            <option value="new">{t('sortNew')}</option>
            <option value="price_asc">{t('sortCheap')}</option>
            <option value="price_desc">{t('sortExpensive')}</option>
          </select>
        </div>
      </div>
      {error ? <div role="alert" className="notice">{t('error')}: <code>{error.code ?? 'UNKNOWN'}</code> <button className="btn secondary" onClick={load}>{t('retry')}</button></div>
        : loading ? <SkeletonGrid />
        : items.length === 0 ? <div className="empty"><p>{t('empty')}</p><Link className="btn secondary" href="/catalog">{t('allCategories')}</Link></div>
        : <div className="pgrid">{items.map((p) => <ProductCard key={p.id} p={p} />)}</div>}
    </>
  );
}

export default function CatalogPage() {
  return <Suspense fallback={<SkeletonGrid />}><Catalog /></Suspense>;
}
