'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CategoryIcon } from '@/components/Icons';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';
import { Chips, copyText, duration, LinkBox } from '../shared';

const SORTS: [string, string][] = [['new', '🕒 Yangi'], ['top', '⭐ TOP'], ['payout', '💰 Ko‘p to‘lanadigan']];

function postText(name: string, price: string, url: string) {
  return `🔥 ${name}\n💵 Narxi: ${price}\n🚚 Yetkazib berish, to‘lov qabul qilganda\n👉 Buyurtma: ${url}`;
}

function MarketCard({ p, onCreated }: { p: any; onCreated: () => void }) {
  const { lang } = useI18n();
  const name = pick(p.name, lang);
  const [open, setOpen] = useState(false);
  const [sname, setSname] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [postCopied, setPostCopied] = useState(false);
  const off = p.compare_at_minor ? Math.round((1 - Number(p.price_minor) / Number(p.compare_at_minor)) * 100) : 0;
  const streamUrl = created?.url ?? (p.my_stream ? `${location.origin}/r/${p.my_stream.code}` : null);
  return (
    <article className="mcard">
      <div className="mcard-img">
        {p.image ? <img src={p.image} alt={name} loading="lazy" /> : <div className="ph" aria-hidden />}
        <div className="mbadges">
          {p.is_new && <span className="mb mb-new">Yangi</span>}
          {p.low_stock && <span className="mb mb-low">Kam qoldi</span>}
          {p.stock === 0 && <span className="mb mb-off">Tugagan</span>}
          {off > 0 && <span className="mb mb-sale">−{off}%</span>}
        </div>
      </div>
      <div className="mcard-body">
        <h3><Link href={`/p/${p.slug}`}>{name}</Link></h3>
        {p.brand && <div className="pbrand">{p.brand}</div>}
        <div className="mstats">
          <div><span>Narx</span><b>{som(p.price_minor)}</b></div>
          <div className="earn"><span>Siz olasiz</span><b>{p.payout_minor ? som(p.payout_minor) : '—'}</b></div>
          <div><span>Qabul / Yetkazish</span><b>{p.accept_rate_pct ?? '—'}{p.accept_rate_pct !== null ? '%' : ''} / {p.delivery_rate_pct ?? '—'}{p.delivery_rate_pct !== null ? '%' : ''}</b></div>
          <div><span>Zaxira</span><b className={p.stock > 5 ? 'ok-t' : 'no-t'}>{p.stock} ta</b></div>
        </div>
        <div className="mship">⏱ O‘rtacha jo‘natish: <b>{duration(p.avg_ship_seconds)}</b> <span className="muted">· 30 kunda {p.orders_30d} buyurtma</span></div>
        {streamUrl ? (
          <>
            <div className="muted small">Sizning oqimingiz:</div>
            <LinkBox url={streamUrl} shareText={`${name} — ${som(p.price_minor)}`} />
            <div className="row" style={{ gap: 8, marginTop: 8 }}>
              <button type="button" className="btn secondary sm" onClick={async () => { if (await copyText(postText(name, som(p.price_minor), streamUrl))) { setPostCopied(true); setTimeout(() => setPostCopied(false), 1500); } }}>{postCopied ? 'Post nusxalandi ✓' : '👉 Post matnini nusxalash'}</button>
              {p.image && <a className="btn secondary sm" href={p.image.replace(/-w640\.webp$/, '-w1200.webp')} download={`${p.slug}.webp`}>Rasmni yuklab olish</a>}
            </div>
          </>
        ) : open ? (
          <form className="stream-form" onSubmit={async (e) => {
            e.preventDefault(); setBusy(true); setErr(null);
            try { setCreated(await api('/partner/streams', { method: 'POST', body: { product_id: p.id, name: sname.trim() || 'Asosiy oqim' } })); onCreated(); } catch (x: any) { setErr(x.code ?? 'ERROR'); } finally { setBusy(false); }
          }}>
            <label htmlFor={`sn-${p.id}`}>Oqim nomi (masalan: Telegram kanal)</label>
            <input id={`sn-${p.id}`} value={sname} maxLength={80} onChange={(e) => setSname(e.target.value)} placeholder="Asosiy oqim" />
            <div className="row" style={{ gap: 8, marginTop: 8 }}>
              <button className="btn" disabled={busy}>Yaratish</button>
              <button type="button" className="btn secondary" onClick={() => setOpen(false)}>Bekor</button>
            </div>
            {err && <div className="field-error" role="alert">{err}</div>}
          </form>
        ) : (
          <button type="button" className="btn big" disabled={p.stock === 0 || !p.payout_minor} onClick={() => setOpen(true)}>Oqim yaratish</button>
        )}
        {p.stock > 0 && <Link href={`/partner/new?product=${encodeURIComponent(p.slug)}`} className="btn secondary full mt8">📞 Mijoz uchun buyurtma</Link>}
        <AdTexts productId={p.id} />
      </div>
    </article>
  );
}

export default function PartnerMarket() {
  const { lang } = useI18n();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('new');
  const [cat, setCat] = useState('');
  const [cats, setCats] = useState<any[]>([]);
  const [items, setItems] = useState<any[] | null>(null);
  const [err, setErr] = useState<any>(null);
  const load = () => {
    setErr(null);
    const qs = new URLSearchParams({ sort });
    if (query) qs.set('q', query);
    if (cat) qs.set('category', cat);
    api(`/partner/market?${qs}`).then((r) => setItems(r.items)).catch(setErr);
  };
  useEffect(() => { api('/categories').then((c) => setCats(c.items.filter((x: any) => !x.parent_id))).catch(() => {}); }, []);
  useEffect(load, [sort, cat, query]);
  return (
    <>
      <h1>Market</h1>
      <form className="search plain" role="search" onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); }}>
        <label htmlFor="mq" className="sr-only">Mahsulot bo‘yicha qidiruv</label>
        <input id="mq" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Mahsulot bo‘yicha qidiruv…" />
        <button className="search-btn" aria-label="Izlash">Izlash</button>
      </form>
      <Chips items={SORTS} value={sort} onChange={setSort} label="Saralash" />
      <div className="chips" role="group" aria-label="Kategoriya">
        <button type="button" className={`chip ${!cat ? 'on' : ''}`} onClick={() => setCat('')}>Barchasi</button>
        {cats.map((c) => <button type="button" key={c.id} className={`chip ${cat === c.slug ? 'on' : ''}`} onClick={() => setCat(c.slug)}><CategoryIcon slug={c.slug} size={18} /> {pick(c.name, lang)}</button>)}
      </div>
      {err && <div className="notice" role="alert">{err.code}</div>}
      {items === null && !err && <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>}
      {items && items.length === 0 && <div className="empty">Mahsulot topilmadi</div>}
      {items && <div className="mgrid">{items.map((p) => <MarketCard key={p.id} p={p} onCreated={() => {}} />)}</div>}
      <p className="muted small">“Siz olasiz” — eng arzon variant narxidan hisoblangan joriy komissiya. Haqiqiy summa buyurtma vaqtidagi qoida bo‘yicha qayd etiladi va yetkazilgandan keyin tasdiqlanadi.</p>
    </>
  );
}

/** Ready ad texts built only from catalog facts (V2 §18-B) — copy, paste, done. */
function AdTexts({ productId }: { productId: string }) {
  const [d, setD] = useState<any>(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<number | null>(null);
  return (
    <div className="ad-texts">
      <button type="button" className="link-btn small" aria-expanded={open} onClick={async () => { setOpen(!open); if (!d) setD(await api(`/partner/products/${productId}/ad-texts`).catch(() => null)); }}>📝 Tayyor reklama matni</button>
      {open && d && (
        <div className="ad-list">
          {d.items.map((x: any, i: number) => (
            <div key={i} className="ad-item">
              <div className="spread"><b className="small">{x.style}</b><button type="button" className="btn secondary sm" onClick={async () => { if (await copyText(x.text)) { setCopied(i); setTimeout(() => setCopied(null), 1500); } }}>{copied === i ? 'Nusxalandi ✓' : 'Nusxalash'}</button></div>
              <pre>{x.text}</pre>
            </div>
          ))}
          <p className="small muted">{d.note}</p>
        </div>
      )}
    </div>
  );
}
