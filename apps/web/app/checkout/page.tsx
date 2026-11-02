'use client';
import { useEffect, useRef, useState } from 'react';
import { api, som } from '@/lib/api';
import { notifyCart } from '@/components/Header';
import { pick, useI18n } from '@/lib/i18n';

export default function Checkout() {
  const { t, lang } = useI18n();
  const [zones, setZones] = useState<any[]>([]);
  // Form state lives in this component and survives language switches (T015) and validation errors (T018).
  const [f, setF] = useState({ name: '', phone: '', district: '', street: '', house: '', apartment: '', landmark: '', zone: '', payment: 'cod', referral: '', promo: '' });
  const [terms, setTerms] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const [quote, setQuote] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<any>(null);
  const idem = useRef<string>('');
  useEffect(() => { api('/delivery-zones').then((r) => { setZones(r.items); if (r.items[0]) setF((x) => ({ ...x, zone: r.items[0].id })); }).catch(setErr); }, []);
  const upd = (k: keyof typeof f) => (e: any) => { setF((x) => ({ ...x, [k]: e.target.value })); setQuote(null); };
  const fe = (k: string) => err?.field_errors?.[k];
  const getQuote = async () => {
    setBusy(true); setErr(null);
    try {
      const zone = zones.find((z) => z.id === f.zone);
      setQuote(await api('/checkout/quotes', { method: 'POST', body: { delivery_zone_id: f.zone, address: { region_code: zone?.region_code ?? 'TAS', district: f.district, street: f.street, house: f.house, apartment: f.apartment || undefined, landmark: f.landmark || undefined }, contact: { name: f.name, phone: f.phone }, promo_code: f.promo || undefined } }));
      idem.current = crypto.randomUUID(); // one key per confirmed quote: double tap / retry cannot create two orders (T019)
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const place = async () => {
    setBusy(true); setErr(null);
    try {
      setDone(await api('/checkout/confirmations', { method: 'POST', idem: idem.current, body: { quote_id: quote.quote_id, quote_hash: quote.quote_hash, payment_method: f.payment, accept_terms: true, marketing_opt_in: marketing, referral_code: f.referral || undefined } })); notifyCart();
    } catch (e: any) {
      if (e.code === 'QUOTE_CHANGED') { setQuote({ ...quote, ...e.details.new_quote, changed: true }); idem.current = crypto.randomUUID(); }
      setErr(e);
    } finally { setBusy(false); }
  };
  if (done) return (
    <div className="card notice ok" role="status">
      <h1>{t('orderPlaced')}: {done.number}</h1>
      <p>{done.confirmation === 'verified' ? t('verified') : t('awaitingCall')}</p>
      {f.payment === 'online' && done.confirmation === 'verified' && <a className="btn" href={`/orders/${done.order_id}`}>{t('payment')} →</a>}
    </div>
  );
  return (
    <>
      <h1>{t('checkout')}</h1>
      {err && <div role="alert" className="notice">{err.code === 'QUOTE_CHANGED' ? t('priceChanged') : `${t('error')}: ${err.code}`}</div>}
      <div className="card">
        <label htmlFor="name">{t('name')}</label><input id="name" autoComplete="name" value={f.name} onChange={upd('name')} />{fe('body.contact.name') && <div className="field-error">{fe('body.contact.name')}</div>}
        <label htmlFor="phone">{t('phone')}</label><input id="phone" type="tel" autoComplete="tel" inputMode="tel" placeholder="+998 90 123 45 67" value={f.phone} onChange={upd('phone')} aria-invalid={!!fe('body.contact.phone')} />{fe('body.contact.phone') && <div className="field-error">Telefon raqami noto‘g‘ri (+998…)</div>}
        <label htmlFor="zone">{t('delivery')}</label>
        <select id="zone" value={f.zone} onChange={upd('zone')}>{zones.map((z) => <option key={z.id} value={z.id}>{pick(z.name, lang)} — {som(z.tariff_minor)} · {z.eta_min_days}–{z.eta_max_days} {t('days')}</option>)}</select>
        <label htmlFor="district">{t('district')}</label><input id="district" value={f.district} onChange={upd('district')} />
        <label htmlFor="street">{t('street')}</label><input id="street" autoComplete="address-line1" value={f.street} onChange={upd('street')} />
        <div className="row"><div style={{ flex: 1 }}><label htmlFor="house">{t('house')}</label><input id="house" value={f.house} onChange={upd('house')} /></div><div style={{ flex: 1 }}><label htmlFor="apt">{t('apartment')}</label><input id="apt" value={f.apartment} onChange={upd('apartment')} /></div></div>
        <label htmlFor="landmark">{t('landmark')}</label><input id="landmark" value={f.landmark} onChange={upd('landmark')} />
        <label htmlFor="pay">{t('payment')}</label>
        <select id="pay" value={f.payment} onChange={upd('payment')}><option value="cod">{t('cod')}</option><option value="online">{t('online')}</option></select>
        <label htmlFor="ref">{t('referral')}</label><input id="ref" value={f.referral} onChange={upd('referral')} autoCapitalize="characters" />{fe('body.referral_code') && <div className="field-error">Kod topilmadi</div>}
        <label htmlFor="promo">Promokod</label><input id="promo" value={f.promo} onChange={upd('promo')} autoCapitalize="characters" />
        <div className="sticky-cta"><button className="btn" disabled={busy || !f.name || !f.phone || !f.street || !f.house || !f.district} onClick={getQuote}>{t('getQuote')}</button></div>
      </div>
      {quote && (
        <div className="card" style={{ marginTop: 12 }} aria-live="polite">
          {quote.lines.map((l: any) => <div key={l.sku_id} className="spread"><span>{pick(l.product.name, lang)} × {l.qty}</span><span>{som(l.net.amount_minor)}</span></div>)}
          <hr />
          <div className="spread"><span>{t('subtotal')}</span><span>{som(quote.subtotal.amount_minor)}</span></div>
          {quote.discount.amount_minor !== '0' && <div className="spread"><span>{t('discount')}</span><span>−{som(quote.discount.amount_minor)}</span></div>}
          <div className="spread"><span>{t('delivery')}</span><span>{som(quote.delivery.amount_minor)}{quote.delivery_discount.amount_minor !== '0' ? ` (−${som(quote.delivery_discount.amount_minor)})` : ''}</span></div>
          <div className="spread" style={{ fontWeight: 700, fontSize: 20 }}><span>{t('total')}</span><span>{som(quote.payable.amount_minor)}</span></div>
          <div className="row"><label className="row" style={{ fontWeight: 400, margin: 0 }}><input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} style={{ width: 24, minHeight: 24 }} /> {t('terms')}</label> <a href="/legal/offer" target="_blank" rel="noopener">(oferta)</a></div>
          <label className="row" style={{ fontWeight: 400 }}><input type="checkbox" checked={marketing} onChange={(e) => setMarketing(e.target.checked)} style={{ width: 24, minHeight: 24 }} /> {t('marketing')}</label>
          <div className="sticky-cta"><button className="btn" disabled={busy || !terms} onClick={place}>{t('placeOrder')} · {som(quote.payable.amount_minor)}</button></div>
        </div>
      )}
    </>
  );
}
