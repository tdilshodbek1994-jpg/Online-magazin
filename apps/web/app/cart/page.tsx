'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Async, notifyCart } from '@/components/Header';
import { IconCart } from '@/components/Icons';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';

export default function CartPage() {
  const { t, lang } = useI18n();
  const [cart, setCart] = useState<any>(null);
  const [st, setSt] = useState<{ loading: boolean; error: any }>({ loading: true, error: null });
  const load = useCallback(async () => {
    setSt({ loading: true, error: null });
    try { setCart(await api('/cart')); setSt({ loading: false, error: null }); } catch (e) { setSt({ loading: false, error: e }); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const setQty = async (sku: string, qty: number) => { try { setCart(await api('/cart/lines', { method: 'PUT', body: { sku_id: sku, qty } })); notifyCart(); } catch (e) { setSt({ loading: false, error: e }); } };
  const lines = cart?.lines ?? [];
  return (
    <>
      <h1>{t('cart')}</h1>
      <Async loading={st.loading} error={st.error} onRetry={load}>
        {lines.length === 0 ? <div className="empty"><IconCart size={48} /><p>{t('emptyCart')}</p><Link className="btn" href="/catalog">{t('shopNow')}</Link></div> : (
          <>
            {lines.map((l: any) => (
              <div key={l.id} className="card cart-line">
                <Link href={`/p/${l.slug}`} className="cart-img">{l.image ? <img src={l.image} alt="" width={88} height={88} /> : <div className="ph" aria-hidden />}</Link>
                <div className="cart-info">
                  <Link href={`/p/${l.slug}`}>{pick(l.name, lang)}</Link> <span className="muted">{Object.values(l.variant ?? {}).join(' / ')}</span>
                  <div className="price">{som(l.price.amount_minor)}</div>
                  {!l.purchasable && <div className="field-error">{t('outOfStock')}</div>}
                  {l.exceeds_stock && <div className="field-error">Omborda {l.available} dona bor</div>}
                </div>
                <div className="row cart-qty">
                  <label className="sr-only" htmlFor={`q-${l.id}`}>{t('qty')}</label>
                  <input id={`q-${l.id}`} type="number" min={1} max={99} value={l.qty} onChange={(e) => setQty(l.sku_id, Math.max(1, Number(e.target.value) || 1))} style={{ width: 80 }} />
                  <button className="btn secondary" onClick={() => setQty(l.sku_id, 0)}>{t('remove')}</button>
                </div>
              </div>
            ))}
            <p className="muted">Savatdagi narx kafolat emas: yakuniy summa checkoutda serverdan hisoblanadi.</p>
            <div className="sticky-cta"><Link className="btn" href="/checkout" style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}>{t('checkout')}</Link></div>
          </>
        )}
      </Async>
    </>
  );
}
