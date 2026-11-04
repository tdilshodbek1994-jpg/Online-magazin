'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { notifyCart } from '@/components/Header';
import { IconCash, IconCheck, IconMinus, IconPlus, IconReturn, IconShield, IconTruck } from '@/components/Icons';
import { discountPct } from '@/components/ProductCard';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';
import { Gallery } from './Gallery';
import { QuickOrder } from './QuickOrder';
import { errText } from '@/lib/errors';
import { PriceWatch } from './PriceWatch';

export function AddToCart({ product, minPrice }: { product: any; minPrice: string | null }) {
  const { t, lang } = useI18n();
  const variants: any[] = product.variants ?? [];
  const [skuId, setSkuId] = useState<string>(variants.find((v) => v.available > 0)?.sku_id ?? variants[0]?.sku_id ?? '');
  const [qty, setQty] = useState(1);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const v = variants.find((x) => x.sku_id === skuId);
  const name = pick(product.name, lang);
  const off = discountPct(v?.price_minor, v?.compare_at_minor);
  const inStock = !!v && v.available > 0;
  const maxQty = Math.max(1, Math.min(99, v?.available ?? 1));
  const [zone, setZone] = useState<any>(null);
  const [quickKey, setQuickKey] = useState(0);
  useEffect(() => { api('/delivery-zones').then((r) => setZone((r.items ?? [])[0] ?? null)).catch(() => {}); }, []);
  const sold = Number(product.sold_30d ?? 0);
  const save = off > 0 && v ? BigInt(v.compare_at_minor) - BigInt(v.price_minor) : 0n;
  const add = async () => {
    setBusy(true); setMsg(null);
    try {
      const cart = await api('/cart');
      const existing = cart.lines?.find((l: any) => l.sku_id === skuId)?.qty ?? 0;
      await api('/cart/lines', { method: 'PUT', body: { sku_id: skuId, qty: existing + qty } });
      setMsg('ok'); notifyCart();
    } catch (e: any) { setMsg(errText(e)); } finally { setBusy(false); }
  };
  return (
    <>
      <nav className="crumbs" aria-label="breadcrumb">
        <Link href="/">{t('home')}</Link><span>/</span>
        {product.category_slug && <><Link href={`/catalog?category=${product.category_slug}`}>{pick(product.category_name, lang)}</Link><span>/</span></>}
        <span>{name}</span>
      </nav>
      <div className="pdp">
        <Gallery media={product.media ?? []} name={name} off={off} slug={product.slug} />
        <div className="buybox">
          {product.brand && <div className="pbrand">{product.brand}{product.model ? ` · ${product.model}` : ''}</div>}
          <h1>{name}</h1>
          <div className={`price-block ${off > 0 ? 'deal' : ''}`} aria-live="polite">
            <div className="price-row big">
              <span className={`price ${off > 0 ? 'is-deal' : ''}`}>{v ? som(v.price_minor) : som(minPrice)}</span>
              {off > 0 && <><s className="was">{som(v.compare_at_minor)}</s><span className="b-off pdp-off">−{off}%</span></>}
            </div>
            {save > 0n && <div className="save-t">Tejaysiz: <b>{som(save.toString())}</b></div>}
            <PriceWatch productId={product.id} />
            <div className="pmeta">
              {sold > 0 && <span className="sold-chip">🔥 30 kunda {sold} {t('sold')}</span>}
              {inStock && v.available <= 5 && <span className="few-t">⏳ {t('fewLeft')}: {v.available} {t('pcs')}</span>}
            </div>
          </div>
          {variants.length > 1 && (
            <fieldset className="variants">
              <legend>{t('variant')}</legend>
              <div className="row">
                {variants.map((x) => (
                  <label key={x.sku_id} className={`vchip ${skuId === x.sku_id ? 'on' : ''} ${x.available > 0 ? '' : 'off'}`}>
                    <input type="radio" name="variant" className="sr-only" checked={skuId === x.sku_id} onChange={() => { setSkuId(x.sku_id); setQty(1); setMsg(null); }} />
                    {Object.values(x.variant).join(' / ') || x.sku_code}{x.available > 0 ? '' : ` (${t('outOfStock')})`}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <p className={inStock ? 'stock ok-t' : 'stock no-t'}>{inStock ? t('inStock') : t('outOfStock')} <span className="muted">· SKU: <code>{v?.sku_code}</code></span></p>
          <div className="qty-row">
            <span className="qty-label" id="qty-l">{t('qty')}</span>
            <div className="stepper" role="group" aria-labelledby="qty-l">
              <button type="button" aria-label="−1" onClick={() => setQty(Math.max(1, qty - 1))} disabled={qty <= 1}><IconMinus size={18} /></button>
              <label htmlFor="qty" className="sr-only">{t('qty')}</label>
              <input id="qty" type="number" inputMode="numeric" min={1} max={maxQty} value={qty} onChange={(e) => setQty(Math.min(maxQty, Math.max(1, Number(e.target.value) || 1)))} />
              <button type="button" aria-label="+1" onClick={() => setQty(Math.min(maxQty, qty + 1))} disabled={qty >= maxQty}><IconPlus size={18} /></button>
            </div>
          </div>
          {zone && (
            <div className="ship-box">
              <div><span aria-hidden>🚚</span> <b>{zone.eta_min_days}–{zone.eta_max_days} kunda yetkazamiz</b> · {pick(zone.name, lang)}</div>
              <div className="muted small">Yetkazish: {som(zone.tariff_minor)}{zone.free_from_minor ? ` · ${som(zone.free_from_minor)} dan bepul` : ''} · {t('codShort')}</div>
            </div>
          )}
          <div className="buy-cta">
            <button className="btn big" disabled={!inStock || busy} onClick={add}>{t('addToCart')}</button>
            {msg === 'ok' && <div className="added" role="status"><IconCheck size={18} /> {t('added')} · <Link href="/cart">{t('cart')} →</Link></div>}
            {msg && msg !== 'ok' && <span role="alert" className="field-error">{msg}</span>}
          </div>
          <div id="quick-order"><QuickOrder key={quickKey} skuId={skuId} qty={qty} disabled={!inStock} autoOpen={quickKey > 0} /></div>
          <ul className="perks">
            <li><IconCash size={20} /> {t('bCod')}</li>
            <li><IconTruck size={20} /> {zone ? `${t('delivery')}: ${zone.eta_min_days}–${zone.eta_max_days} kun, ${som(zone.tariff_minor)}` : t('delivery')}</li>
            <li><IconReturn size={20} /> <Link href="/legal/returns">{t('returns')}</Link></li>
            {product.warranty_months ? <li><IconShield size={20} /> {t('warranty')}: {product.warranty_months} {t('months')}</li> : null}
          </ul>
        </div>
      </div>
      {/* Mobile sticky buy bar: the price and both actions are always one tap away while reading. */}
      {msg === 'ok' && <div className="bb-toast" role="status">✓ {t('added')} · <Link href="/cart">Savatni ochish</Link></div>}
      <div className="buy-bar" aria-label="Xarid paneli">
        <div className="bb-price"><b className={off > 0 ? 'is-deal' : ''}>{v ? som(v.price_minor) : som(minPrice)}</b>{off > 0 && <s>{som(v.compare_at_minor)}</s>}</div>
        <button className="btn secondary" disabled={!inStock || busy} onClick={add}>🛒 Savatga</button>
        <button className="btn bb-now" disabled={!inStock} onClick={() => { setQuickKey((k) => k + 1); setTimeout(() => document.getElementById('quick-order')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50); }}>Hozir olish</button>
      </div>
      <Specs product={product} lang={lang} />
      {pick(product.description, lang) && (
        <section className="card desc">
          <h2>{t('description')}</h2>
          <div style={{ whiteSpace: 'pre-wrap' }}>{pick(product.description, lang)}</div>
        </section>
      )}
    </>
  );
}

/** "Xususiyatlar": only facts the catalog really has (brand, model, warranty, category, variant options, codes). */
function Specs({ product, lang }: { product: any; lang: any }) {
  const variants: any[] = product.variants ?? [];
  const opts: Record<string, string[]> = {};
  for (const v of variants) for (const [k, val] of Object.entries(v.variant ?? {})) { (opts[k] ??= []); if (!opts[k].includes(String(val))) opts[k].push(String(val)); }
  const rows: [string, string][] = [];
  if (product.brand) rows.push(['Brend', product.brand]);
  if (product.model) rows.push(['Model', product.model]);
  if (product.category_name) rows.push(['Toifa', pick(product.category_name, lang)]);
  for (const [k, vals] of Object.entries(opts)) rows.push([k.charAt(0).toUpperCase() + k.slice(1), vals.join(', ')]);
  rows.push(['Kafolat', product.warranty_months ? `${product.warranty_months} oy` : 'Ko‘rsatilmagan']);
  const inStock = variants.filter((v) => v.available > 0).length;
  if (variants.length > 1) rows.push(['Mavjud variantlar', `${inStock} / ${variants.length}`]);
  if (variants.length) rows.push(['Mahsulot kodi', variants.map((v) => v.sku_code).slice(0, 4).join(', ') + (variants.length > 4 ? ' …' : '')]);
  if (rows.length < 2) return null;
  return (
    <section className="card specs" aria-labelledby="specs-h">
      <h2 id="specs-h">Xususiyatlar</h2>
      <dl className="spec-list">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
    </section>
  );
}
