'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AiAssistant } from '@/components/AiAssistant';
import { CategoryIcon, IconCash, IconChevron, IconReturn, IconShield, IconTruck } from '@/components/Icons';
import { discountPct, ProductCard, SkeletonGrid } from '@/components/ProductCard';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';

/**
 * Home, rebuilt as a marketplace front page (patterns from large marketplaces, our own look):
 * dense price-first cards, a promo carousel built from real catalog data, photo category tiles,
 * "Kun xitlari" by real sales, category quads, a deals grid, a budget rail and an endless "Siz uchun" feed.
 * Persuasion stays honest: real discounts, real stock, real sales counts — no fake ratings or timers.
 */
type P = any;
const PAGE = 20;

function useEta() {
  const [eta, setEta] = useState<string | null>(null);
  useEffect(() => {
    api('/delivery-zones').then((r) => {
      const z = r.items ?? [];
      if (!z.length) return;
      const min = Math.min(...z.map((x: any) => x.eta_min_days)), max = Math.max(...z.map((x: any) => x.eta_max_days));
      setEta(min === max ? `${min}` : `${min}–${max}`);
    }).catch(() => {});
  }, []);
  return eta;
}

function SectionHead({ title, sub, href, badge }: { title: string; sub?: string; href?: string; badge?: string }) {
  const { t } = useI18n();
  return (
    <div className="sec-head">
      <div>
        <h2>{badge && <span className="sec-badge">{badge}</span>}{title}</h2>
        {sub && <p className="muted small">{sub}</p>}
      </div>
      {href && <Link href={href} className="sec-more">{t('seeAll')} <IconChevron size={16} /></Link>}
    </div>
  );
}

function Hero({ deals, fresh }: { deals: P[]; fresh: P[] }) {
  const { t } = useI18n();
  const maxOff = deals.reduce((m, p) => Math.max(m, discountPct(p.min_price?.amount_minor, p.compare_at?.amount_minor)), 0);
  const slides = [
    maxOff > 0 && { key: 'sale', cls: 's-sale', href: '/catalog?sort=discount', kicker: t('saleTitle'), title: `−${maxOff}% ${t('upTo')}`, sub: t('saleSub'), imgs: deals.filter((p) => p.image).slice(0, 3) },
    { key: 'new', cls: 's-new', href: '/catalog?sort=new', kicker: t('newTitle'), title: t('newTitle'), sub: t('newSub'), imgs: fresh.filter((p) => p.image).slice(0, 3) },
    { key: 'cod', cls: 's-cod', href: '/catalog', kicker: 'UzShop', title: t('codTitle'), sub: t('codSub'), imgs: [] as P[] },
  ].filter(Boolean) as { key: string; cls: string; href: string; kicker: string; title: string; sub: string; imgs: P[] }[];
  const ref = useRef<HTMLDivElement>(null);
  const [i, setI] = useState(0);
  const paused = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => setI(Math.round(el.scrollLeft / Math.max(1, el.clientWidth)));
    el.addEventListener('scroll', onScroll, { passive: true });
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const timer = reduce ? null : setInterval(() => {
      if (paused.current || !el) return;
      const next = (Math.round(el.scrollLeft / el.clientWidth) + 1) % slides.length;
      el.scrollTo({ left: next * el.clientWidth, behavior: 'smooth' });
    }, 5000);
    return () => { el.removeEventListener('scroll', onScroll); if (timer) clearInterval(timer); };
  }, [slides.length]);
  return (
    <section className="hero2" aria-roledescription="carousel" aria-label="Aksiyalar" onMouseEnter={() => { paused.current = true; }} onMouseLeave={() => { paused.current = false; }} onTouchStart={() => { paused.current = true; }}>
      <div className="hero2-track" ref={ref}>
        {slides.map((s) => (
          <Link key={s.key} href={s.href} className={`hero2-slide ${s.cls}`}>
            <div className="h2-text">
              <span className="h2-kicker">{s.kicker}</span>
              <b className="h2-title">{s.title}</b>
              <span className="h2-sub">{s.sub}</span>
              <span className="h2-cta">{t('viewAll')} <IconChevron size={16} /></span>
            </div>
            <div className="h2-art" aria-hidden>
              {s.imgs.length ? s.imgs.map((p, k) => <img key={p.id} src={p.image} alt="" className={`h2-img i${k}`} />) : <span className="h2-icon"><IconCash size={84} /></span>}
            </div>
          </Link>
        ))}
      </div>
      <div className="hero2-dots" role="tablist">
        {slides.map((s, k) => <button key={s.key} role="tab" aria-selected={i === k} aria-label={`${k + 1}`} className={i === k ? 'on' : ''} onClick={() => ref.current?.scrollTo({ left: k * ref.current.clientWidth, behavior: 'smooth' })} />)}
      </div>
    </section>
  );
}

function Rail({ items, eta }: { items: P[]; eta: string | null }) {
  return <div className="hrail">{items.map((p) => <ProductCard key={p.id} p={p} eta={eta} compact />)}</div>;
}

/** Amazon-style card: one category, four real products, one link. */
function Quad({ cat, items }: { cat: P; items: P[] }) {
  const { t, lang } = useI18n();
  return (
    <section className="quad">
      <h3>{pick(cat.name, lang)}</h3>
      <div className="quad-grid">
        {items.slice(0, 4).map((p) => (
          <Link key={p.id} href={`/p/${p.slug}`} className="quad-item">
            {p.image ? <img src={p.image} alt="" loading="lazy" /> : <span className="ph" aria-hidden />}
            <span className="quad-name">{pick(p.name, lang)}</span>
            <b className={p.compare_at ? 'is-deal' : ''}>{som(p.min_price?.amount_minor)}</b>
          </Link>
        ))}
      </div>
      <Link href={`/catalog?category=${cat.slug}`} className="sec-more">{t('viewAll')} <IconChevron size={16} /></Link>
    </section>
  );
}

export default function Home() {
  const { t, lang } = useI18n();
  const eta = useEta();
  const [cats, setCats] = useState<P[]>([]);
  const [hits, setHits] = useState<P[]>([]);
  const [deals, setDeals] = useState<P[]>([]);
  const [fresh, setFresh] = useState<P[]>([]);
  const [budget, setBudget] = useState<P[]>([]);
  const [quads, setQuads] = useState<{ cat: P; items: P[] }[]>([]);
  const [reels, setReels] = useState<P[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const [feed, setFeed] = useState<P[]>([]);
  const [feedEnd, setFeedEnd] = useState(false);
  const feedBusy = useRef(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const [showTop, setShowTop] = useState(false);

  const load = () => {
    setLoading(true); setError(null);
    Promise.all([
      api('/categories'), api('/products?limit=12&sort=popular&in_stock=true'), api('/products?limit=12&sort=discount&in_stock=true'),
      api('/products?limit=12&sort=new'), api('/products?limit=12&sort=popular&in_stock=true&max_price=100000'),
    ])
      .then(async ([c, h, d, n, b]) => {
        setCats(c.items); setHits(h.items.filter((p: P) => Number(p.sold_30d) > 0)); setDeals(d.items); setFresh(n.items); setBudget(b.items);
        const roots = c.items.filter((x: P) => !x.parent_id).slice(0, 4);
        const q = await Promise.all(roots.map((cat: P) => api(`/products?limit=4&sort=popular&in_stock=true&category=${encodeURIComponent(cat.slug)}`).then((r) => ({ cat, items: r.items })).catch(() => ({ cat, items: [] }))));
        setQuads(q.filter((x) => x.items.length >= 4));
      })
      .catch(setError)
      .finally(() => setLoading(false));
  };
  useEffect(load, []);
  useEffect(() => { api('/reels?limit=10').then((r) => setReels(r.items)).catch(() => {}); }, []);

  // Endless "Siz uchun" feed: next page loads as the shopper nears the end.
  const more = useCallback(async () => {
    if (feedBusy.current || feedEnd) return;
    feedBusy.current = true;
    try {
      const r = await api(`/products?limit=${PAGE}&offset=${feed.length}&sort=new`);
      setFeed((f) => { const seen = new Set(f.map((x) => x.id)); return [...f, ...r.items.filter((x: P) => !seen.has(x.id))]; });
      if (r.items.length < PAGE) setFeedEnd(true);
    } catch { setFeedEnd(true); } finally { feedBusy.current = false; }
  }, [feed.length, feedEnd]);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => { if (e[0]?.isIntersecting) void more(); }, { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [more]);
  useEffect(() => { const f = () => setShowTop(window.scrollY > 1200); window.addEventListener('scroll', f, { passive: true }); return () => window.removeEventListener('scroll', f); }, []);

  const roots = cats.filter((c) => !c.parent_id);
  const tiles = [...roots, ...cats.filter((c) => c.parent_id)].slice(0, 9);
  return (
    <div className="home2">
      <nav className="quick-chips" aria-label="Tezkor bo‘limlar">
        <Link href="/catalog?sort=discount" className="qchip hot">🔥 {t('chipDeals')}</Link>
        <Link href="/catalog?sort=popular" className="qchip">⭐ {t('chipHits')}</Link>
        <Link href="/catalog?sort=new" className="qchip">🆕 {t('chipNew')}</Link>
        <Link href="/catalog?max_price=100000" className="qchip">💸 {t('chipCheap')}</Link>
        <Link href="/reels" className="qchip">▶ Video</Link>
        {roots.map((c) => <Link key={c.id} href={`/catalog?category=${c.slug}`} className="qchip">{pick(c.name, lang)}</Link>)}
      </nav>

      {error && <div role="alert" className="notice">{t('error')}: <code>{error.code ?? 'UNKNOWN'}</code> <button className="btn secondary" onClick={load}>{t('retry')}</button></div>}

      {loading ? <div className="hero2 sk-hero" aria-hidden /> : <Hero deals={deals} fresh={fresh} />}

      <ul className="trust">
        <li><IconCash size={20} /><span>{t('bCod')}</span></li>
        <li><IconTruck size={20} /><span>{eta ? `${eta} ${t('deliveryLine')}` : t('bFast')}</span></li>
        <li><IconReturn size={20} /><span>{t('bReturn')}</span></li>
        <li><IconShield size={20} /><span>{t('bWarranty')}</span></li>
      </ul>

      {tiles.length > 0 && (
        <section className="sec">
          <SectionHead title={t('categories')} href="/catalog" />
          <div className="cat-tiles">
            {tiles.map((c) => (
              <Link key={c.id} href={`/catalog?category=${c.slug}`} className="cat-tile">
                <span className="ct-name">{pick(c.name, lang)}</span>
                {c.cover ? <img src={c.cover} alt="" loading="lazy" /> : <span className="ct-ico"><CategoryIcon slug={c.slug} /></span>}
              </Link>
            ))}
          </div>
        </section>
      )}

      {hits.length > 0 && (
        <section className="sec sec-hot">
          <SectionHead title={t('hits')} sub={t('hitsSub')} href="/catalog?sort=popular" badge={t('hitBadge')} />
          <Rail items={hits} eta={eta} />
        </section>
      )}

      {quads.length > 0 && <div className="quads">{quads.map((q) => <Quad key={q.cat.id} cat={q.cat} items={q.items} />)}</div>}

      {deals.length > 0 && (
        <section className="sec">
          <SectionHead title={t('saleTitle')} sub={t('saleSub')} href="/catalog?sort=discount" badge="%" />
          <div className="pgrid">{deals.slice(0, 8).map((p) => <ProductCard key={p.id} p={p} eta={eta} />)}</div>
        </section>
      )}

      {reels.length > 0 && (
        <section className="sec">
          <SectionHead title="▶ Video sharhlar" href="/reels" />
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

      {budget.length > 0 && (
        <section className="sec">
          <SectionHead title={t('underBudget')} href="/catalog?max_price=100000" />
          <Rail items={budget} eta={eta} />
        </section>
      )}

      {fresh.length > 0 && (
        <section className="sec">
          <SectionHead title={t('newArrivals')} href="/catalog?sort=new" />
          <Rail items={fresh} eta={eta} />
        </section>
      )}

      <section className="sec"><AiAssistant /></section>

      <section className="sec">
        <SectionHead title={t('forYou')} />
        {loading ? <SkeletonGrid n={6} /> : <div className="pgrid">{feed.map((p) => <ProductCard key={p.id} p={p} eta={eta} />)}</div>}
        <div ref={sentinel} className="feed-end" role="status">{feedEnd ? t('endOfFeed') : t('loadingMore')}</div>
      </section>

      {showTop && <button className="to-top" aria-label={t('backToTop')} onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>↑</button>}
    </div>
  );
}
