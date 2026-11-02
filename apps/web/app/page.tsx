'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AiAssistant } from '@/components/AiAssistant';
import { CategoryIcon, IconCash, IconChevron, IconReturn, IconShield, IconTruck } from '@/components/Icons';
import { ProductCard, SkeletonGrid } from '@/components/ProductCard';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';

function Rail({ title, href, items, loading }: { title: string; href: string; items: any[]; loading: boolean }) {
  const { t } = useI18n();
  if (!loading && items.length === 0) return null;
  return (
    <section className="rail">
      <div className="rail-head">
        <h2>{title}</h2>
        <Link href={href} className="see-all">{t('seeAll')} <IconChevron size={16} /></Link>
      </div>
      {loading ? <SkeletonGrid n={4} /> : <div className="pgrid">{items.map((p) => <ProductCard key={p.id} p={p} />)}</div>}
    </section>
  );
}

export default function Home() {
  const { t, lang } = useI18n();
  const [cats, setCats] = useState<any[]>([]);
  const [fresh, setFresh] = useState<any[]>([]);
  const [cheap, setCheap] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [reels, setReels] = useState<any[]>([]);
  const [error, setError] = useState<any>(null);
  const load = () => {
    setLoading(true); setError(null);
    Promise.all([api('/categories'), api('/products?limit=10&sort=new'), api('/products?limit=10&sort=price_asc&in_stock=true')])
      .then(([c, n, ch]) => { setCats(c.items); setFresh(n.items); setCheap(ch.items); })
      .catch(setError)
      .finally(() => setLoading(false));
  };
  useEffect(load, []);
  useEffect(() => { api('/reels?limit=10').then((r) => setReels(r.items)).catch(() => {}); }, []);
  const deals = [...fresh, ...cheap].filter((p, i, a) => p.compare_at && a.findIndex((x) => x.id === p.id) === i).slice(0, 8);
  const heroImgs = fresh.filter((p) => p.image).slice(0, 3);
  return (
    <>
      <section className="hero">
        <div className="hero-text">
          <span className="hero-tag">UzShop</span>
          <h1>{t('heroTitle')}</h1>
          <p>{t('heroSub')}</p>
          <Link href="/catalog" className="btn hero-btn">{t('shopNow')} <IconChevron size={18} /></Link>
        </div>
        <div className="hero-art" aria-hidden>
          {heroImgs.map((p, i) => <img key={p.id} src={p.image} alt="" className={`hero-img h${i}`} />)}
        </div>
      </section>

      <ul className="benefits">
        <li><IconCash /><div><b>{t('bCod')}</b><span>{t('bCodSub')}</span></div></li>
        <li><IconTruck /><div><b>{t('bFast')}</b><span>{t('bFastSub')}</span></div></li>
        <li><IconReturn /><div><b>{t('bReturn')}</b><span>{t('bReturnSub')}</span></div></li>
        <li><IconShield /><div><b>{t('bWarranty')}</b><span>{t('bWarrantySub')}</span></div></li>
      </ul>

      {error && <div role="alert" className="notice">{t('error')}: <code>{error.code ?? 'UNKNOWN'}</code> <button className="btn secondary" onClick={load}>{t('retry')}</button></div>}

      {cats.length > 0 && (
        <section className="rail">
          <div className="rail-head"><h2>{t('categories')}</h2></div>
          <div className="cats">
            {cats.map((c) => (
              <Link key={c.id} href={`/catalog?category=${c.slug}`} className="cat">
                <span className="cat-ico"><CategoryIcon slug={c.slug} /></span>
                <span>{pick(c.name, lang)}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {reels.length > 0 && (
        <section className="rail">
          <div className="rail-head"><h2>▶ Video sharhlar</h2><Link href="/reels" className="see-all">{t('seeAll')} <IconChevron size={16} /></Link></div>
          <div className="vrail">
            {reels.map((v) => (
              <Link key={v.id} href={`/reels?v=${v.id}`} className="vtile" aria-label={`Video: ${pick(v.name, lang)}`}>
                {(v.poster || v.image) && <img src={v.poster ?? v.image} alt="" loading="lazy" />}
                <span className="vplay" aria-hidden>▶</span>
                <span className="vprice">{som(v.price_minor)}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {deals.length > 0 && <Rail title={t('deals')} href="/catalog" items={deals} loading={false} />}
      <Rail title={t('newArrivals')} href="/catalog?sort=new" items={fresh} loading={loading} />
      <Rail title={t('bestPrice')} href="/catalog?sort=price_asc" items={cheap} loading={loading} />

      <section className="rail"><AiAssistant /></section>
    </>
  );
}
