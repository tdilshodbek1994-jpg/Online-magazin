'use client';
import Link from 'next/link';
import { useState } from 'react';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';
import { errText } from '@/lib/errors';

/**
 * Landing renderer for all templates (simple / pro / boom / multi) from the allowlisted block schema. Text is rendered
 * as text nodes only. Prices/stock/images come from the live catalog facts in `data.products`. Preview mode never
 * places orders. Boom adds light motion that is switched off under prefers-reduced-motion.
 */
export function LandingView({ data }: { data: any }) {
  const { lang } = useI18n();
  const p = data.products?.[0];
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
  const order = async () => {
    if (data.preview) { setErr('Ko‘rib chiqish rejimi — buyurtma yuborilmaydi.'); return; }
    setBusy(true); setErr(null);
    try { setDone(await api('/checkout/quick-order', { method: 'POST', idem: crypto.randomUUID(), body: { sku_id: skuId, qty, name, phone, accept_terms: true, landing: { landing_id: data.id, revision: data.revision } } })); }
    catch (e: any) { setErr(errText(e)); } finally { setBusy(false); }
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
          case 'footer': return <footer key={b.id} className="lp-footer small">{b.props.text || 'UzShop — sotuvchi va aloqa ma’lumotlari sayt pastida.'}</footer>;
          case 'order_form': return (
            <section key={b.id} className={`lp-form ${b.props.sticky ? 'sticky' : ''}`} id="lp-order">
              {unavailable ? <div className="notice">Bu mahsulot hozir mavjud emas. <Link href="/catalog">Boshqa mahsulotlarni ko‘rish</Link></div>
                : done ? <div className="notice ok">✓ Buyurtma so‘rovi qabul qilindi. Operator tez orada qo‘ng‘iroq qilib, manzil va to‘lovni aniqlaydi.</div>
                : (
                  <>
                    {(p?.skus?.length ?? 0) > 1 && <><label htmlFor="lp-sku">Variant</label><select id="lp-sku" value={skuId} onChange={(e) => setSkuId(e.target.value)}>{p.skus.map((s: any) => <option key={s.sku_id} value={s.sku_id} disabled={s.available < 1}>{Object.values(s.variant ?? {}).join(' / ') || 'Asosiy'} — {som(s.price_minor)}{s.available < 1 ? ' (tugagan)' : ''}</option>)}</select></>}
                    <label htmlFor="lp-q">Miqdor</label><input id="lp-q" type="number" min={1} max={20} value={qty} onChange={(e) => setQty(Math.max(1, Math.min(20, Number(e.target.value) || 1)))} />
                    <label htmlFor="lp-n">Ismingiz</label><input id="lp-n" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
                    <label htmlFor="lp-p">Telefon</label><input id="lp-p" type="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+998 90 123 45 67" />
                    {err && <p className="field-error" role="alert">{err}</p>}
                    <button className="btn big full" disabled={busy || name.trim().length < 2 || phone.replace(/\D/g, '').length < 9} onClick={order}>{b.props.cta}{cur ? ` — ${som(String(BigInt(cur.price_minor) * BigInt(qty)))}` : ''}</button>
                    <p className="small muted">Buyurtma berish uchun reklama roziligi shart emas. Narx va mavjudlik buyurtma paytida server tomonidan tekshiriladi.</p>
                  </>)}
            </section>);
          default: return null;
        }
      })}
    </article>
  );
}
