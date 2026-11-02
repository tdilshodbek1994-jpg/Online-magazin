'use client';
import Link from 'next/link';
import { useState } from 'react';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';

export function AddToCart({ product, minPrice }: { product: any; minPrice: string | null }) {
  const { t, lang } = useI18n();
  const variants: any[] = product.variants ?? [];
  const [skuId, setSkuId] = useState<string>(variants.find((v) => v.available > 0)?.sku_id ?? variants[0]?.sku_id ?? '');
  const [qty, setQty] = useState(1);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const v = variants.find((x) => x.sku_id === skuId);
  return (
    <div className="card">
      <h1>{pick(product.name, lang)}</h1>
      {product.brand && <p className="muted">{product.brand}{product.model ? ` · ${product.model}` : ''}</p>}
      <p style={{ fontSize: 22, fontWeight: 700 }} aria-live="polite">{v ? som(v.price_minor) : som(minPrice)}</p>
      {variants.length > 1 && (
        <fieldset style={{ border: 0, padding: 0 }}>
          <legend style={{ fontWeight: 600 }}>Variant</legend>
          <div className="row">
            {variants.map((x) => (
              <label key={x.sku_id} className="badge" style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <input type="radio" name="variant" checked={skuId === x.sku_id} onChange={() => setSkuId(x.sku_id)} style={{ width: 'auto', minHeight: 0 }} />
                {Object.values(x.variant).join(' / ') || x.sku_code} {x.available > 0 ? '' : `(${t('outOfStock')})`}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <p>{v && v.available > 0 ? `${t('inStock')}` : t('outOfStock')} · SKU: <code>{v?.sku_code}</code></p>
      <label htmlFor="qty">{t('qty')}</label>
      <input id="qty" type="number" min={1} max={99} value={qty} onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))} style={{ maxWidth: 120 }} />
      <div className="sticky-cta row">
        <button className="btn" disabled={!v || v.available <= 0 || busy} onClick={async () => {
          setBusy(true); setMsg(null);
          try {
            const cart = await api('/cart');
            const existing = cart.lines?.find((l: any) => l.sku_id === skuId)?.qty ?? 0;
            await api('/cart/lines', { method: 'PUT', body: { sku_id: skuId, qty: existing + qty } });
            setMsg('ok');
          } catch (e: any) { setMsg(e.code ?? 'ERROR'); } finally { setBusy(false); }
        }}>{t('addToCart')}</button>
        {msg === 'ok' && <Link href="/cart">{t('cart')} →</Link>}
        {msg && msg !== 'ok' && <span role="alert" className="field-error">{msg}</span>}
      </div>
      <p className="muted">{t('delivery')}: zona tarifi checkoutda hisoblanadi. <Link href="/legal/returns">{t('returns')}</Link>{product.warranty_months ? ` · Kafolat: ${product.warranty_months} oy` : ''}</p>
      <div style={{ whiteSpace: 'pre-wrap' }}>{pick(product.description, lang)}</div>
    </div>
  );
}
