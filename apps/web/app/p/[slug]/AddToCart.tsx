'use client';
import Link from 'next/link';
import { useState } from 'react';
import { notifyCart } from '@/components/Header';
import { IconCash, IconCheck, IconMinus, IconPlus, IconReturn, IconShield, IconTruck } from '@/components/Icons';
import { discountPct } from '@/components/ProductCard';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';
import { Gallery } from './Gallery';
import { QuickOrder } from './QuickOrder';

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
  return (
    <>
      <nav className="crumbs" aria-label="breadcrumb">
        <Link href="/">{t('home')}</Link><span>/</span>
        {product.category_slug && <><Link href={`/catalog?category=${product.category_slug}`}>{pick(product.category_name, lang)}</Link><span>/</span></>}
        <span>{name}</span>
      </nav>
      <div className="pdp">
        <Gallery media={product.media ?? []} name={name} off={off} />
        <div className="buybox">
          {product.brand && <div className="pbrand">{product.brand}{product.model ? ` · ${product.model}` : ''}</div>}
          <h1>{name}</h1>
          <div className="price-row big" aria-live="polite">
            <span className="price">{v ? som(v.price_minor) : som(minPrice)}</span>
            {off > 0 && <><s className="was">{som(v.compare_at_minor)}</s><span className="sale inline">−{off}%</span></>}
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
          <div className="buy-cta">
            <button className="btn big" disabled={!inStock || busy} onClick={async () => {
              setBusy(true); setMsg(null);
              try {
                const cart = await api('/cart');
                const existing = cart.lines?.find((l: any) => l.sku_id === skuId)?.qty ?? 0;
                await api('/cart/lines', { method: 'PUT', body: { sku_id: skuId, qty: existing + qty } });
                setMsg('ok'); notifyCart();
              } catch (e: any) { setMsg(e.code ?? 'ERROR'); } finally { setBusy(false); }
            }}>{t('addToCart')}</button>
            {msg === 'ok' && <div className="added" role="status"><IconCheck size={18} /> {t('added')} · <Link href="/cart">{t('cart')} →</Link></div>}
            {msg && msg !== 'ok' && <span role="alert" className="field-error">{msg}</span>}
          </div>
          <QuickOrder skuId={skuId} qty={qty} disabled={!inStock} />
          <ul className="perks">
            <li><IconCash size={20} /> {t('bCod')}</li>
            <li><IconTruck size={20} /> {t('delivery')}: zona tarifi checkoutda hisoblanadi</li>
            <li><IconReturn size={20} /> <Link href="/legal/returns">{t('returns')}</Link></li>
            {product.warranty_months ? <li><IconShield size={20} /> {t('warranty')}: {product.warranty_months} {t('months')}</li> : null}
          </ul>
        </div>
      </div>
      {pick(product.description, lang) && (
        <section className="card desc">
          <h2>{t('description')}</h2>
          <div style={{ whiteSpace: 'pre-wrap' }}>{pick(product.description, lang)}</div>
        </section>
      )}
    </>
  );
}
