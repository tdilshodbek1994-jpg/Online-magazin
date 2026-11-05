'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Async, notifyCart } from '@/components/Header';
import { IconCart, IconCash, IconMinus, IconPlus, IconReturn, IconShield } from '@/components/Icons';
import { discountPct, ProductCard } from '@/components/ProductCard';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';

/**
 * Cart in marketplace style: clear line items with −/+ steppers, a summary with the real delivery tariff
 * (and a "free from" progress bar only when the zone really has a free threshold), "Bular bilan birga olishadi"
 * from real order history, and a sticky checkout bar on phones. Prices here are indicative; the final
 * amount is always computed by the server at checkout.
 */
export default function CartPage() {
  const { t, lang } = useI18n();
  const [cart, setCart] = useState<any>(null);
  const [st, setSt] = useState<{ loading: boolean; error: any }>({ loading: true, error: null });
  const [zone, setZone] = useState<any>(null);
  const [also, setAlso] = useState<{ basis: string; items: any[] } | null>(null);
  const [hits, setHits] = useState<any[]>([]);
  const load = useCallback(async () => {
    setSt({ loading: true, error: null });
    try { setCart(await api('/cart')); setSt({ loading: false, error: null }); } catch (e) { setSt({ loading: false, error: e }); }
  }, []);
  useEffect(() => { void load(); api('/delivery-zones').then((r) => setZone((r.items ?? [])[0] ?? null)).catch(() => {}); }, [load]);
  const lines: any[] = cart?.lines ?? [];
  const pids = [...new Set(lines.map((l) => l.product_id).filter(Boolean))].join(',');
  useEffect(() => {
    if (pids) api(`/products/also-bought?product_ids=${pids}`).then(setAlso).catch(() => setAlso(null));
    else api('/products?limit=10&sort=popular&in_stock=true').then((r) => setHits(r.items)).catch(() => {});
  }, [pids]);
  const setQty = async (sku: string, qty: number) => { try { setCart(await api('/cart/lines', { method: 'PUT', body: { sku_id: sku, qty } })); notifyCart(); } catch (e) { setSt({ loading: false, error: e }); } };
  const units = lines.reduce((a, l) => a + Number(l.qty), 0);
  const subtotal = lines.reduce((a, l) => a + BigInt(l.price.amount_minor) * BigInt(l.qty), 0n);
  const saved = lines.reduce((a, l) => a + (l.compare_at_minor && BigInt(l.compare_at_minor) > BigInt(l.price.amount_minor) ? (BigInt(l.compare_at_minor) - BigInt(l.price.amount_minor)) * BigInt(l.qty) : 0n), 0n);
  const freeFrom = zone?.free_from_minor ? BigInt(zone.free_from_minor) : null;
  const delivery = zone ? (freeFrom !== null && subtotal >= freeFrom ? 0n : BigInt(zone.tariff_minor)) : null;
  const blocked = lines.some((l) => !l.purchasable || l.exceeds_stock);
  return (
    <div className="cart2">
      <h1>{t('cart')}{units > 0 && <span className="muted"> · {units} ta</span>}</h1>
      <Async loading={st.loading} error={st.error} onRetry={load}>
        {lines.length === 0 ? (
          <>
            <div className="empty"><IconCart size={48} /><p>{t('emptyCart')}</p><Link className="btn" href="/catalog">{t('shopNow')}</Link></div>
            {hits.length > 0 && <section className="sec"><div className="sec-head"><h2><span className="sec-badge">{t('hitBadge')}</span>{t('hits')}</h2></div><div className="hrail">{hits.map((p) => <ProductCard key={p.id} p={p} compact />)}</div></section>}
          </>
        ) : (
          <div className="cart-grid">
            <div className="cart-lines">
              {lines.map((l: any) => {
                const off = discountPct(l.price.amount_minor, l.compare_at_minor);
                return (
                  <div key={l.id} className="cart-line2">
                    <Link href={`/p/${l.slug}`} className="cl-img">{l.image ? <img src={l.image} alt="" width={96} height={96} /> : <div className="ph" aria-hidden />}{off > 0 && <span className="b-off cl-off">−{off}%</span>}</Link>
                    <div className="cl-info">
                      <Link href={`/p/${l.slug}`} className="cl-name">{pick(l.name, lang)}</Link>
                      {Object.values(l.variant ?? {}).length > 0 && <span className="muted small">{Object.values(l.variant ?? {}).join(' / ')}</span>}
                      <div className="cl-price"><b className={off > 0 ? 'is-deal' : ''}>{som(l.price.amount_minor)}</b>{off > 0 && <s className="muted small">{som(l.compare_at_minor)}</s>}</div>
                      {!l.purchasable && <div className="field-error">{t('outOfStock')}</div>}
                      {l.exceeds_stock && <div className="field-error">Omborda {l.available} dona bor</div>}
                      {l.purchasable && !l.exceeds_stock && l.available <= 5 && <div className="few-t small">{t('fewLeft')}: {l.available} {t('pcs')}</div>}
                      <div className="cl-qty">
                        <div className="stepper sm" role="group" aria-label={`${t('qty')}: ${pick(l.name, lang)}`}>
                          <button type="button" aria-label="−1" onClick={() => setQty(l.sku_id, Math.max(1, Number(l.qty) - 1))} disabled={Number(l.qty) <= 1}><IconMinus size={16} /></button>
                          <label className="sr-only" htmlFor={`q-${l.id}`}>{t('qty')}</label>
                          <input id={`q-${l.id}`} type="number" inputMode="numeric" min={1} max={99} value={l.qty} onChange={(e) => setQty(l.sku_id, Math.max(1, Math.min(99, Number(e.target.value) || 1)))} />
                          <button type="button" aria-label="+1" onClick={() => setQty(l.sku_id, Math.min(99, Number(l.qty) + 1))} disabled={Number(l.qty) >= Math.min(99, Number(l.available))}><IconPlus size={16} /></button>
                        </div>
                        <button className="link-btn small" onClick={() => setQty(l.sku_id, 0)}>{t('remove')}</button>
                        <b className="cl-total">{som((BigInt(l.price.amount_minor) * BigInt(l.qty)).toString())}</b>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <aside className="cart-sum card" aria-label="Buyurtma xulosasi">
              <div className="sum-row"><span>Mahsulotlar ({units} ta)</span><b>{som(subtotal.toString())}</b></div>
              {saved > 0n && <div className="sum-row save-t"><span>Chegirma bilan tejaysiz</span><b>−{som(saved.toString())}</b></div>}
              <div className="sum-row"><span>Yetkazish{zone ? ` · ${zone.eta_min_days}–${zone.eta_max_days} kun` : ''}</span><b>{delivery === null ? '—' : delivery === 0n ? 'Bepul' : som(delivery.toString())}</b></div>
              {freeFrom !== null && subtotal < freeFrom && (
                <div className="free-bar" role="status">
                  <span>Yana <b>{som((freeFrom - subtotal).toString())}</b> qo‘shsangiz — yetkazish bepul</span>
                  <div className="fb-track" aria-hidden><div className="fb-fill" style={{ width: `${Math.min(100, Number((subtotal * 100n) / freeFrom))}%` }} /></div>
                </div>
              )}
              <div className="sum-row total"><span>Taxminiy jami</span><b>{som((subtotal + (delivery ?? 0n)).toString())}</b></div>
              <Link className={`btn big full ${blocked ? 'disabled' : ''}`} aria-disabled={blocked} href={blocked ? '#' : '/checkout'} onClick={(e) => { if (blocked) e.preventDefault(); }}>{t('checkout')}</Link>
              {blocked && <p className="field-error small">Avval tugagan yoki omborda yetmaydigan mahsulotlarni tuzating.</p>}
              <ul className="cart-trust">
                <li><IconCash size={18} /> To‘lov mahsulotni olganda</li>
                <li><IconShield size={18} /> Kafolat va rasmiy chek</li>
                <li><IconReturn size={18} /> <Link href="/legal/returns">Qaytarish shartlari</Link></li>
              </ul>
              <p className="muted small">Yakuniy summa rasmiylashtirishda serverda aniq hisoblanadi.</p>
            </aside>
          </div>
        )}
        {lines.length > 0 && also && also.items.length > 0 && (
          <section className="sec">
            <div className="sec-head"><h2>{also.basis === 'together' ? 'Bular bilan birga olishadi' : 'O‘xshash mahsulotlar'}</h2></div>
            <div className="hrail">{also.items.map((p) => <ProductCard key={p.id} p={p} compact />)}</div>
          </section>
        )}
        {lines.length > 0 && (
          <div className="cart-bar">
            <div><span className="muted small">Taxminiy jami</span><b>{som((subtotal + (delivery ?? 0n)).toString())}</b></div>
            <Link className={`btn ${blocked ? 'disabled' : ''}`} aria-disabled={blocked} href={blocked ? '#' : '/checkout'} onClick={(e) => { if (blocked) e.preventDefault(); }}>{t('checkout')} →</Link>
          </div>
        )}
      </Async>
    </div>
  );
}
