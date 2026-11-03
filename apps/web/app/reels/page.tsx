'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { IconClose, IconHeart, IconShare, IconSound } from '@/components/Icons';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';
import { QuickOrder } from '../p/[slug]/QuickOrder';
import { errText } from '@/lib/errors';

function BuySheet({ item, onClose }: { item: any; onClose: () => void }) {
  const { lang } = useI18n();
  const avail = (item.variants ?? []).filter((v: any) => v.available > 0);
  const [sku, setSku] = useState<string>(avail[0]?.sku_id ?? '');
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Buyurtma berish" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          {item.image && <img src={item.image} alt="" width={56} height={56} />}
          <div><b>{pick(item.name, lang)}</b><div className="price">{som(item.price_minor)}</div></div>
          <button className="icon-btn" aria-label="Yopish" onClick={onClose}><IconClose size={20} /></button>
        </div>
        {avail.length === 0 ? <p className="notice">Afsuski, hozir mavjud emas.</p> : (
          <>
            {avail.length > 1 && (
              <div className="row" style={{ gap: 8 }} role="radiogroup" aria-label="Variant">
                {avail.map((v: any) => <button key={v.sku_id} type="button" role="radio" aria-checked={sku === v.sku_id} className={`vchip ${sku === v.sku_id ? 'on' : ''}`} onClick={() => setSku(v.sku_id)}>{Object.values(v.variant).join(' / ') || 'Standart'}</button>)}
              </div>
            )}
            <QuickOrder key={sku} skuId={sku} qty={1} disabled={!sku} autoOpen onClose={onClose} />
            <Link href={`/p/${item.slug}`} className="muted small" style={{ textAlign: 'center' }}>Mahsulot sahifasini ochish →</Link>
          </>
        )}
      </div>
    </div>
  );
}

function Reel({ item, active, muted, onToggleMute, onBuy }: { item: any; active: boolean; muted: boolean; onToggleMute: () => void; onBuy: () => void }) {
  const { lang } = useI18n();
  const ref = useRef<HTMLVideoElement>(null);
  const viewed = useRef(false);
  const [liked, setLiked] = useState<boolean>(item.liked);
  const [likes, setLikes] = useState<number>(item.likes);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (active) {
      v.play().catch(() => {});
      if (!viewed.current) { viewed.current = true; api(`/reels/${item.id}/view`, { method: 'POST' }).catch(() => {}); }
    } else v.pause();
  }, [active, item.id]);
  const name = pick(item.name, lang);
  const off = item.compare_at_minor ? Math.round((1 - Number(item.price_minor) / Number(item.compare_at_minor)) * 100) : 0;
  return (
    <section className="reel" aria-label={name}>
      <video ref={ref} src={item.url} poster={item.poster ?? item.image ?? undefined} muted={muted} loop playsInline preload={active ? 'auto' : 'metadata'} onClick={onToggleMute} />
      <div className="reel-actions">
        <button aria-label={liked ? 'Yoqdi (bekor qilish)' : 'Yoqdi'} aria-pressed={liked} className={liked ? 'on' : ''} onClick={async () => {
          const next = !liked; setLiked(next); setLikes((n) => n + (next ? 1 : -1));
          try { const r = await api(`/reels/${item.id}/like`, { method: 'POST', body: { like: next } }); setLikes(r.likes); } catch { setLiked(!next); }
        }}><IconHeart size={30} filled={liked} /><span>{likes}</span></button>
        <button aria-label="Ulashish" onClick={async () => {
          const url = `${location.origin}/reels?v=${item.id}`;
          try { if (navigator.share) { await navigator.share({ title: name, url }); return; } } catch { return; }
          try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
        }}><IconShare size={28} /><span>{copied ? 'Nusxa' : 'Ulashish'}</span></button>
        <button aria-label={muted ? 'Ovozni yoqish' : 'Ovozni o‘chirish'} onClick={onToggleMute}><IconSound size={28} off={muted} /><span>{muted ? 'Ovoz' : 'Jim'}</span></button>
      </div>
      <div className="reel-bottom">
        {pick(item.caption, lang) && <p className="reel-caption">{pick(item.caption, lang)}</p>}
      <div className="reel-card">
        <Link href={`/p/${item.slug}`} className="reel-thumb" aria-label={name}>{item.image ? <img src={item.image} alt="" width={64} height={64} /> : null}</Link>
        <div className="reel-info">
          <Link href={`/p/${item.slug}`} className="reel-name">{name}</Link>
          <div className="reel-price"><b>{som(item.price_minor)}</b>{off > 0 && <s>{som(item.compare_at_minor)}</s>}</div>
        </div>
        <button className="btn reel-buy" onClick={onBuy}>🛒 Buyurtma berish</button>
      </div>
      </div>
    </section>
  );
}

function Feed() {
  const router = useRouter();
  const sp = useSearchParams();
  const startId = sp.get('v');
  const [items, setItems] = useState<any[]>([]);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<any>(null);
  const [active, setActive] = useState(0);
  const [muted, setMuted] = useState(true);
  const [buy, setBuy] = useState<any>(null);
  const box = useRef<HTMLDivElement>(null);
  const loading = useRef(false);
  const more = useCallback(async () => {
    if (loading.current || done) return;
    loading.current = true;
    try {
      const r = await api(`/reels?limit=10&offset=${items.length}`);
      setItems((prev) => { const seen = new Set(prev.map((x) => x.id)); return [...prev, ...r.items.filter((x: any) => !seen.has(x.id))]; });
      if (r.items.length < 10) setDone(true);
    } catch (e) { setErr(e); } finally { loading.current = false; }
  }, [items.length, done]);
  useEffect(() => { void more(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Deep link: start at the shared video.
  useEffect(() => {
    if (!startId || !items.length) return;
    const i = items.findIndex((x) => x.id === startId);
    if (i > 0) box.current?.children[i]?.scrollIntoView({ behavior: 'instant' as ScrollBehavior });
  }, [startId, items.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const root = box.current;
    if (!root) return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.i));
    }, { root, threshold: 0.6 });
    Array.from(root.children).forEach((c) => io.observe(c));
    return () => io.disconnect();
  }, [items.length]);
  useEffect(() => { if (active >= items.length - 3) void more(); }, [active, items.length, more]);
  useEffect(() => { document.body.classList.add('reels-open'); return () => document.body.classList.remove('reels-open'); }, []);
  return (
    <div className="reels">
      <button className="reels-close" aria-label="Yopish" onClick={() => (history.length > 1 ? router.back() : router.push('/'))}><IconClose size={24} /></button>
      {err && <div className="reels-empty"><p>{errText(err)}</p></div>}
      {!err && done && items.length === 0 && <div className="reels-empty"><p>Hali video yo‘q.</p><Link className="btn" href="/catalog">Katalogga o‘tish</Link></div>}
      <div className="reels-scroll" ref={box}>
        {items.map((it, i) => <div key={it.id} data-i={i} className="reel-slot"><Reel item={it} active={i === active} muted={muted} onToggleMute={() => setMuted((m) => !m)} onBuy={() => setBuy(it)} /></div>)}
      </div>
      {buy && <BuySheet item={buy} onClose={() => setBuy(null)} />}
    </div>
  );
}

export default function ReelsPage() { return <Suspense fallback={null}><Feed /></Suspense>; }
