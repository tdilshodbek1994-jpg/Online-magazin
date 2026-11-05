'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CategoryIcon } from '@/components/Icons';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';
import { Chips, copyText, duration, LinkBox } from '../shared';
import { errText } from '@/lib/errors';

const SORTS: [string, string][] = [['new', '🕒 Yangi'], ['top', '⭐ TOP'], ['payout', '💰 Ko‘p to‘lanadigan']];

function postText(name: string, price: string, url: string) {
  return `🔥 ${name}\n💵 Narxi: ${price}\n🚚 Yetkazib berish, to‘lov qabul qilganda\n👉 Buyurtma: ${url}`;
}

function MarketCard({ p, onCreated }: { p: any; onCreated: () => void }) {
  const { lang } = useI18n();
  const name = pick(p.name, lang);
  const [open, setOpen] = useState(false);
  const [sname, setSname] = useState('');
  const [sdisc, setSdisc] = useState('');
  const [landings, setLandings] = useState<any[]>([]);
  const [landing, setLanding] = useState('');
  const [channel, setChannel] = useState('telegram');
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
        <div className="mprice">
          <div><b className="mprice-v">{som(p.price_minor)}</b>{p.compare_at_minor && <s className="muted small">{som(p.compare_at_minor)}</s>}</div>
          <div className="mearn"><span>Sizga</span><b>{p.payout_minor ? som(p.payout_minor) : '—'}</b></div>
        </div>
        <div className="mfacts">
          <span className={p.stock > 5 ? 'ok' : p.stock > 0 ? 'warn' : 'no'}>📦 Omborda {p.stock} ta</span>
          <span>🛒 Oxirgi 30 kunda {p.orders_30d} ta buyurtma</span>
          {p.accept_rate_pct !== null && <span>✅ Tasdiqlangan {p.accept_rate_pct}%</span>}
          {p.delivery_rate_pct !== null && <span>🚚 Yetkazilgan {p.delivery_rate_pct}%</span>}
          {p.avg_ship_seconds ? <span>⏱ Jo‘natishgacha ~{duration(p.avg_ship_seconds)}</span> : null}
        </div>
        {streamUrl ? (
          <>
            <div className="mlink-h">🔗 Sizning havolangiz</div>
            <LinkBox url={streamUrl} shareText={`${name} — ${som(p.price_minor)}`} />
            <div className="row" style={{ gap: 8, marginTop: 8 }}>
              <button type="button" className="btn secondary sm full" onClick={async () => { if (await copyText(postText(name, som(p.price_minor), streamUrl))) { setPostCopied(true); setTimeout(() => setPostCopied(false), 1500); } }}>{postCopied ? 'Post nusxalandi ✓' : '👉 Post matnini nusxalash'}</button>
            </div>
          </>
        ) : open ? (
          <form className="stream-form" onSubmit={async (e) => {
            e.preventDefault(); setBusy(true); setErr(null);
            try { setCreated(await api('/partner/streams', { method: 'POST', body: { product_id: p.id, name: sname.trim() || 'Asosiy oqim', ...(sdisc ? { customer_discount_minor: String(BigInt(sdisc) * 100n) } : {}), ...(landing ? { landing_id: landing, channel } : {}) } })); onCreated(); } catch (x: any) { setErr(x.code === 'DISCOUNT_TOO_BIG' ? 'Chegirma bonusingizdan katta bo‘lmasin.' : errText(x)); } finally { setBusy(false); }
          }}>
            <label htmlFor={`sn-${p.id}`}>Oqim nomi (masalan: Telegram kanal)</label>
            <input id={`sn-${p.id}`} value={sname} maxLength={80} onChange={(e) => setSname(e.target.value)} placeholder="Asosiy oqim" />
            {landings.filter((l) => (l.product_ids ?? []).includes(p.id)).length > 0 && (<>
              <label htmlFor={`sl-${p.id}`}>Landing sahifa (ixtiyoriy)</label>
              <select id={`sl-${p.id}`} value={landing} onChange={(e) => setLanding(e.target.value)}><option value="">— mahsulot sahifasi —</option>{landings.filter((l) => (l.product_ids ?? []).includes(p.id)).map((l) => <option key={l.id} value={l.id}>{l.title}</option>)}</select>
              {landing && <><label htmlFor={`sc-${p.id}`}>Manba</label><select id={`sc-${p.id}`} value={channel} onChange={(e) => setChannel(e.target.value)}><option value="telegram">Telegram</option><option value="instagram">Instagram</option><option value="facebook">Facebook</option><option value="other">Boshqa</option></select></>}
            </>)}
            <label htmlFor={`sd-${p.id}`}>🎁 Mijoz uchun chegirma (ixtiyoriy, so‘m)</label>
            <input id={`sd-${p.id}`} inputMode="numeric" value={sdisc} onChange={(e) => setSdisc(e.target.value.replace(/\D/g, '').slice(0, 9))} placeholder="0" />
            <p className="muted small">Mijoz narxni shuncha arzon ko‘radi; chegirma bonusingizdan ayiriladi{p.payout_minor ? ` (eng ko‘pi ${som(p.payout_minor)})` : ''}. Bo‘sh qoldirsangiz — oddiy havola.</p>
            <div className="row" style={{ gap: 8, marginTop: 8 }}>
              <button className="btn" disabled={busy}>Yaratish</button>
              <button type="button" className="btn secondary" onClick={() => setOpen(false)}>Bekor</button>
            </div>
            {err && <div className="field-error" role="alert">{err}</div>}
          </form>
        ) : (
          <button type="button" className="btn big" disabled={p.stock === 0 || !p.payout_minor} onClick={() => { setOpen(true); if (!landings.length) api('/partner/landings').then((r) => setLandings(r.items ?? [])).catch(() => {}); }}>Oqim yaratish</button>
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
  const [shown, setShown] = useState(20);
  const load = () => {
    setErr(null); setShown(20);
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
      {err && <div className="notice" role="alert">{errText(err)}</div>}
      {items === null && !err && <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>}
      {items && items.length === 0 && <div className="empty">Mahsulot topilmadi</div>}
      {items && items.length > 0 && <p className="muted small">{items.length} ta mahsulot</p>}
      {items && <div className="mgrid">{items.slice(0, shown).map((p) => <MarketCard key={p.id} p={p} onCreated={() => {}} />)}</div>}
      {items && items.length > shown && <button className="btn secondary full mt8" onClick={() => setShown(shown + 20)}>Yana ko‘rsatish ({items.length - shown} ta qoldi)</button>}
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
