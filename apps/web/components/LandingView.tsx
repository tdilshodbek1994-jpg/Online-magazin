'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';
import { errText } from '@/lib/errors';
import { browserContext, trackEvent } from '@/lib/tracking';

/**
 * Landing renderer for all templates (simple / pro / boom / multi) from the allowlisted block schema. Text is rendered
 * as text nodes only. Prices/stock/images come from the live catalog facts in `data.products`. Preview mode never
 * places orders. Boom adds light motion that is switched off under prefers-reduced-motion.
 */
/** Promotion countdown from the server's promotion window (offset by server time; a refresh never restarts it). */
function PromoTimer({ code, label, onState }: { code: string; label?: string; onState: (active: boolean) => void }) {
  const [info, setInfo] = useState<{ ends: number; offset: number; active: boolean } | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    api(`/landings/promo/${code}`).then((r) => { const i = { ends: Date.parse(r.ends_at), offset: Date.parse(r.server_now) - Date.now(), active: r.active }; setInfo(i); onState(i.active); }).catch(() => onState(false));
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [code]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!info) return null;
  const left = info.ends - (now + info.offset);
  if (!info.active || left <= 0) { if (info.active) { info.active = false; onState(false); } return <section className="lp-promo small muted">Aksiya tugagan.</section>; }
  const h = Math.floor(left / 3_600_000), m = Math.floor((left % 3_600_000) / 60_000), sec = Math.floor((left % 60_000) / 1000);
  return <section className="lp-promo" aria-live="polite"><b>{label || 'Aksiya tugashiga'}:</b> {String(h).padStart(2, '0')}:{String(m).padStart(2, '0')}:{String(sec).padStart(2, '0')} <span className="small muted">(promokod {code} avtomatik qo‘llanadi)</span></section>;
}

export function LandingView({ data: initial }: { data: any }) {
  const { lang } = useI18n();
  const [data, setData] = useState<any>(initial);
  useEffect(() => setData(initial), [initial]);
  const p = data.products?.[0];
  const multi = data.template === 'multi' && (data.products?.length ?? 0) > 1;
  const [mq, setMq] = useState<Record<string, number>>({});
  const [promo, setPromo] = useState<{ code: string; active: boolean } | null>(null);
  const [offline, setOffline] = useState(false);
  const sku = (p?.skus ?? []).find((s: any) => s.available > 0) ?? p?.skus?.[0];
  const [skuId, setSkuId] = useState<string | undefined>(sku?.sku_id);
  const [qty, setQty] = useState(1);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const cur = (p?.skus ?? []).find((s: any) => s.sku_id === skuId) ?? sku;
  const unavailable = data.availability === 'unavailable';
  // Measurement only for the real published page (never preview) and only with consent — see lib/tracking.
  useEffect(() => { if (!data.preview && data.id) void trackEvent('landing.rendered', { landing_id: data.id }); }, [data.preview, data.id]);
  // LT-009: when the connection drops nothing is queued for automatic sending. After reconnecting, live prices are reloaded
  // and the customer presses the button again (the server re-prices anyway).
  useEffect(() => {
    if (!offline || data.preview || !data.slug) return;
    const back = () => { api(`/landings/${data.slug}`).then((d) => { setData({ ...d, preview: false }); setOffline(false); setErr('Aloqa tiklandi. Narx va mavjudlik yangilandi — tekshirib, tugmani qayta bosing.'); }).catch(() => {}); };
    window.addEventListener('online', back);
    return () => window.removeEventListener('online', back);
  }, [offline, data.preview, data.slug]);
  const multiLines = multi ? (data.products as any[]).flatMap((x) => { const s0 = (x.skus ?? []).find((s: any) => s.available > 0); const q = mq[x.id] ?? 0; return s0 && q > 0 ? [{ sku_id: s0.sku_id, qty: q, price: s0.price_minor }] : []; }) : [];
  const total = multi ? multiLines.reduce((a, l) => a + BigInt(l.price) * BigInt(l.qty), 0n) : cur ? BigInt(cur.price_minor) * BigInt(qty) : null;
  const order = async () => {
    if (data.preview) { setErr('Ko‘rib chiqish rejimi — buyurtma yuborilmaydi.'); return; }
    if (typeof navigator !== 'undefined' && !navigator.onLine) { setOffline(true); setErr('Internet yo‘q — buyurtma yuborilmadi va avtomatik yuborilmaydi. Aloqa tiklangach narx yangilanadi.'); return; }
    setBusy(true); setErr(null);
    const items = multi ? { lines: multiLines.map(({ sku_id, qty: q }) => ({ sku_id, qty: q })) } : { sku_id: skuId, qty };
    try { setDone(await api('/checkout/quick-order', { method: 'POST', idem: crypto.randomUUID(), body: { ...items, name, phone, accept_terms: true, ...(promo?.active ? { promo_code: promo.code } : {}), landing: { landing_id: data.id, revision: data.revision }, tracking: browserContext() } })); }
    catch (e: any) { if (e.code === 'NETWORK') { setOffline(true); setErr('Internet yo‘q — buyurtma yuborilmadi va avtomatik yuborilmaydi. Aloqa tiklangach narx yangilanadi.'); } else setErr(e.code === 'PROMO_NOT_APPLICABLE' ? 'Aksiya muddati tugagan yoki shartga mos emas — sahifani yangilang.' : errText(e)); } finally { setBusy(false); }
  };
  const blocks = data.definition?.blocks ?? [];
  return (
    <article className={`lp lp-${data.template}`}>
      {data.preview && <div className="notice small">Ko‘rib chiqish (draft) — qidiruvga chiqmaydi, statistika yozilmaydi, buyurtma yuborilmaydi.</div>}
      {blocks.map((b: any) => {
        switch (b.type) {
          case 'hero': return (
            <section key={b.id} className="lp-hero">
              {p?.images?.[0] && <img src={p.images[0].url.replace(/\.webp$/, '.webp')} alt="" />}
              <h1>{b.props.headline || (p ? pick(p.name, lang) : data.title)}</h1>
              {b.props.subline && <p>{b.props.subline}</p>}
              {b.props.show_price && cur && <div className="lp-price"><b>{som(cur.price_minor)}</b>{cur.compare_at_minor && <s>{som(cur.compare_at_minor)}</s>}</div>}
            </section>);
          case 'gallery': return <section key={b.id} className="lp-gallery">{(p?.images ?? []).slice(0, b.props.max).map((im: any, i: number) => <img key={i} src={im.url} alt="" loading="lazy" />)}</section>;
          case 'video': return <section key={b.id} className="lp-video">{b.props.provider === 'youtube' ? <iframe title="Video" src={`https://www.youtube-nocookie.com/embed/${b.props.ref}`} loading="lazy" allowFullScreen sandbox="allow-scripts allow-same-origin allow-presentation" /> : <video src={b.props.ref} controls preload="metadata" />}</section>;
          case 'benefits': return b.props.items.length ? <ul key={b.id} className="lp-benefits">{b.props.items.map((x: string, i: number) => <li key={i}>✓ {x}</li>)}</ul> : null;
          case 'specs': return p?.description ? <section key={b.id} className="lp-specs"><h2>Tavsif</h2><p>{pick(p.description, lang)}</p>{p.warranty_months ? <p className="small">Kafolat: {p.warranty_months} oy</p> : null}</section> : null;
          case 'faq': return b.props.items.length ? <section key={b.id} className="lp-faq"><h2>Savollar</h2>{b.props.items.map((x: any, i: number) => <details key={i}><summary>{x.q}</summary><p>{x.a}</p></details>)}</section> : null;
          case 'delivery_returns': return <section key={b.id} className="lp-dr small"><b>Yetkazish va qaytarish</b><p>{b.props.note || 'Toshkent bo‘ylab 1–2 kunda yetkazish. To‘lov mahsulotni qabul qilganda.'} <Link href="/legal/returns">Qaytarish shartlari</Link></p></section>;
          case 'contact': return b.props.text ? <section key={b.id} className="lp-contact small">{b.props.text}</section> : null;
          case 'promo_timer': return <PromoTimer key={b.id} code={b.props.code} label={b.props.label} onState={(active) => setPromo({ code: b.props.code, active })} />;
          case 'footer': return <footer key={b.id} className="lp-footer small">{b.props.text || 'UzShop — sotuvchi va aloqa ma’lumotlari sayt pastida.'}</footer>;
          case 'order_form': return (
            <section key={b.id} className={`lp-form ${b.props.sticky ? 'sticky' : ''}`} id="lp-order">
              {unavailable ? <div className="notice">Bu mahsulot hozir mavjud emas. <Link href="/catalog">Boshqa mahsulotlarni ko‘rish</Link></div>
                : done ? <div className="notice ok">✓ Buyurtma so‘rovi qabul qilindi. Operator tez orada qo‘ng‘iroq qilib, manzil va to‘lovni aniqlaydi.</div>
                : (
                  <>
                    {multi && (data.products as any[]).map((x) => { const s0 = (x.skus ?? []).find((s: any) => s.available > 0); return (
                      <div key={x.id} className="row" style={{ gap: 8, alignItems: 'center' }}>
                        <label htmlFor={`lp-m-${x.id}`} style={{ flex: 1 }}>{pick(x.name, lang)} — {s0 ? som(s0.price_minor) : 'tugagan'}</label>
                        <input id={`lp-m-${x.id}`} type="number" min={0} max={20} style={{ width: 72 }} disabled={!s0} value={mq[x.id] ?? 0} onChange={(e) => setMq({ ...mq, [x.id]: Math.max(0, Math.min(20, Number(e.target.value) || 0)) })} />
                      </div>); })}
                    {!multi && (p?.skus?.length ?? 0) > 1 && <><label htmlFor="lp-sku">Variant</label><select id="lp-sku" value={skuId} onChange={(e) => setSkuId(e.target.value)}>{p.skus.map((s: any) => <option key={s.sku_id} value={s.sku_id} disabled={s.available < 1}>{Object.values(s.variant ?? {}).join(' / ') || 'Asosiy'} — {som(s.price_minor)}{s.available < 1 ? ' (tugagan)' : ''}</option>)}</select></>}
                    {!multi && <><label htmlFor="lp-q">Miqdor</label><input id="lp-q" type="number" min={1} max={20} value={qty} onChange={(e) => setQty(Math.max(1, Math.min(20, Number(e.target.value) || 1)))} /></>}
                    <label htmlFor="lp-n">Ismingiz</label><input id="lp-n" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
                    <label htmlFor="lp-p">Telefon</label><input id="lp-p" type="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+998 90 123 45 67" />
                    {err && <p className="field-error" role="alert">{err}</p>}
                    <button className="btn big full" disabled={busy || name.trim().length < 2 || phone.replace(/\D/g, '').length < 9 || (multi && !multiLines.length)} onClick={order}>{b.props.cta}{total !== null && total > 0n ? ` — ${som(String(total))}` : ''}</button>
                    <p className="small muted">Buyurtma berish uchun reklama roziligi shart emas. Narx va mavjudlik buyurtma paytida server tomonidan tekshiriladi.</p>
                  </>)}
            </section>);
          default: return null;
        }
      })}
    </article>
  );
}
