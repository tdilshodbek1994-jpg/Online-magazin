'use client';
import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';

/**
 * Offer set as the customer sees it (V2 §08): compare 2–3 products, then "Hozir olaman" (pick one → SMS confirmation)
 * or "Keyin qaror qilaman" (optional single reminder, only with consent). No commission or partner details are shown.
 */
export default function OfferChoice({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const { lang } = useI18n();
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pickSku, setPickSku] = useState<string>('');
  const [mode, setMode] = useState<'compare' | 'buy' | 'later'>('compare');
  const [f, setF] = useState({ name: '', phone: '', zone: '', district: '', street: '', house: '', contact_time: '', terms: false });
  const [later, setLater] = useState({ remind: true, when: 'tomorrow', phone: '', consent: false });
  const [done, setDone] = useState<any>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api(`/offer/${token}`).then((r) => { setD(r); setF((x) => ({ ...x, zone: r.zones?.[0]?.id ?? '' })); api(`/offer/${token}/seen`, { method: 'POST' }).catch(() => {}); })
      .catch((e) => setErr(e.code === 'OFFER_EXPIRED' ? 'Taklif muddati tugagan' : e.code === 'OFFER_ALREADY_CHOSEN' ? 'Siz allaqachon tanlagansiz' : 'Taklif topilmadi'));
  }, [token]);
  if (err) return <div className="card fill-card"><h1>{err}</h1><p>Sizga havola yuborgan sotuvchiga murojaat qiling.</p><Link className="btn" href="/">Do‘konga o‘tish</Link></div>;
  if (done === 'later') return <div className="card fill-card"><div className="sd-icon" aria-hidden>🕊️</div><h1>Shoshilmang</h1><p>{later.remind ? 'Bir marta eslatamiz. ' : ''}Havola muddati tugaguncha istalgan payt qaytib, tanlashingiz mumkin.</p></div>;
  if (done) return (
    <div className="card fill-card">
      <div className="sd-icon" aria-hidden>📩</div>
      <h1>Rahmat! Buyurtmangiz qabul qilindi</h1>
      <p>Buyurtma <b>{done.order_number}</b> tayyorlandi. Tez orada UzShop operatori sizga qo‘ng‘iroq qilib tasdiqlaydi{done.next === 'confirm_by_sms' ? ' (telefoningizga SMS havola ham yuborildi)' : ''}.</p>
      {done.dev_customer_link_token && <p className="badge test">DEMO: <a href={`/confirm/${done.dev_customer_link_token}`}>tasdiqlash sahifasi</a> · kod <code>{done.dev_customer_code}</code></p>}
    </div>
  );
  if (!d) return <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>;
  const chosen = d.products.flatMap((p: any) => (p.variants ?? []).map((v: any) => ({ ...v, product: p }))).find((v: any) => v.sku_id === pickSku);
  const zone = d.zones.find((z: any) => z.id === f.zone);
  const okBuy = chosen && f.name.trim().length >= 2 && f.phone.replace(/\D/g, '').length >= 9 && f.zone && f.district.trim() && f.street.trim() && f.house.trim() && f.terms;
  return (
    <div className="offer-page">
      <h1>Siz uchun tanlangan variantlar</h1>
      {d.note && <p className="offer-note">💬 {d.note}</p>}
      <div className="offer-grid">
        {d.products.map((p: any) => {
          const vs = p.variants ?? [];
          const min = vs.length ? vs.reduce((a: any, b: any) => (BigInt(a.price_minor) <= BigInt(b.price_minor) ? a : b)) : null;
          return (
            <article key={p.id} className={`card offer-card ${chosen?.product.id === p.id ? 'on' : ''}`}>
              {p.image ? <img src={p.image} alt={pick(p.name, lang)} loading="lazy" /> : <div className="ph" aria-hidden />}
              <h2>{pick(p.name, lang)}</h2>
              {p.brand && <div className="pbrand">{p.brand}</div>}
              <div className="offer-price">{min ? som(min.price_minor) : '—'}{min?.compare_at_minor && <s className="muted"> {som(min.compare_at_minor)}</s>}</div>
              <ul className="offer-facts">
                {p.warranty_months ? <li>✅ {p.warranty_months} oy kafolat</li> : null}
                <li>🚚 Yetkazish {d.zones[0] ? `${d.zones[0].eta_min_days}–${d.zones[0].eta_max_days} kun` : '—'}</li>
                <li>💵 To‘lov mahsulotni olganda</li>
              </ul>
              {p.about && <p className="small muted">{p.about.split('\n')[0]}</p>}
              <div className="chips" role="group" aria-label="Variant">
                {vs.map((v: any) => (
                  <button key={v.sku_id} type="button" className={`chip ${pickSku === v.sku_id ? 'on' : ''}`} aria-pressed={pickSku === v.sku_id} disabled={v.available <= 0} onClick={() => { setPickSku(v.sku_id); setMode('buy'); }}>
                    {Object.values(v.variant ?? {}).join(' / ') || 'Tanlash'}{v.available <= 0 ? ' · tugagan' : ''}
                  </button>
                ))}
              </div>
            </article>
          );
        })}
      </div>

      {mode !== 'buy' && (
        <div className="row offer-actions">
          <button className="btn secondary" onClick={() => setMode(mode === 'later' ? 'compare' : 'later')}>Keyin qaror qilaman</button>
          <span className="muted small">Yoqqan variantni tanlang — «Hozir olaman» formasi ochiladi.</span>
        </div>
      )}

      {mode === 'later' && (
        <section className="card fill-card">
          <h2>Keyin qaror qilaman</h2>
          <label className="check-row"><input type="checkbox" checked={later.remind} onChange={(e) => setLater({ ...later, remind: e.target.checked })} /> Bir marta SMS bilan eslatilsin</label>
          {later.remind && (
            <>
              <div className="chips">{[['tomorrow', 'Ertaga'], ['in_3_days', '3 kundan keyin']].map(([k, l]) => <button key={k} type="button" className={`chip ${later.when === k ? 'on' : ''}`} aria-pressed={later.when === k} onClick={() => setLater({ ...later, when: k })}>{l}</button>)}</div>
              <label htmlFor="lp">Telefon raqamingiz</label><input id="lp" type="tel" value={later.phone} onChange={(e) => setLater({ ...later, phone: e.target.value })} placeholder="+998 90 123 45 67" />
              <label className="check-row"><input type="checkbox" checked={later.consent} onChange={(e) => setLater({ ...later, consent: e.target.checked })} /> Shu taklif bo‘yicha bitta eslatma olishga roziman</label>
            </>
          )}
          {formErr && <div className="notice" role="alert">{formErr}</div>}
          <button className="btn" disabled={busy || (later.remind && (!later.consent || later.phone.replace(/\D/g, '').length < 9))} onClick={async () => {
            setBusy(true); setFormErr(null);
            try { await api(`/offer/${token}/later`, { method: 'POST', body: later.remind ? { remind: true, when: later.when, phone: later.phone, consent: true } : { remind: false } }); setDone('later'); } catch (e: any) { setFormErr(e.code === 'PHONE_INVALID' ? 'Telefon raqamini to‘g‘ri kiriting' : 'Xatolik, qayta urinib ko‘ring'); } finally { setBusy(false); }
          }}>Saqlash</button>
        </section>
      )}

      {mode === 'buy' && chosen && (
        <section className="card fill-card" aria-labelledby="buy-h">
          <h2 id="buy-h">Hozir olaman: {pick(chosen.product.name, lang)}{Object.values(chosen.variant ?? {}).length ? ` (${Object.values(chosen.variant).join(' / ')})` : ''}</h2>
          <div className="sum-row"><span>Narx</span><b>{som(chosen.price_minor)}</b></div>
          {zone && <div className="sum-row"><span>Yetkazish</span><b>{som(zone.tariff_minor)}</b></div>}
          <div className="sum-row total"><span>Jami</span><b>{som(String(BigInt(chosen.price_minor) + BigInt(zone?.tariff_minor ?? '0')))}</b></div>
          {formErr && <div className="notice" role="alert">{formErr}</div>}
          <form onSubmit={async (e) => {
            e.preventDefault(); if (!okBuy) return; setBusy(true); setFormErr(null);
            try { setDone(await api(`/offer/${token}/choose`, { method: 'POST', body: { sku_id: pickSku, qty: 1, name: f.name.trim(), phone: f.phone, delivery_zone_id: f.zone, address: { district: f.district.trim(), street: f.street.trim(), house: f.house.trim() }, contact_time: f.contact_time || undefined, accept_terms: true } })); }
            catch (er: any) { setFormErr(er.code === 'PHONE_INVALID' ? 'Telefon raqamini to‘g‘ri kiriting: +998 90 123 45 67' : er.code === 'OUT_OF_STOCK' ? 'Afsuski, bu variant tugab qoldi — boshqasini tanlang.' : 'Xatolik. Qayta urinib ko‘ring.'); }
            finally { setBusy(false); }
          }}>
            <label htmlFor="bn">Ismingiz</label><input id="bn" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="name" />
            <label htmlFor="bp">Telefon raqamingiz</label><input id="bp" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="+998 90 123 45 67" autoComplete="tel" />
            <label htmlFor="bz">Hudud</label><select id="bz" value={f.zone} onChange={(e) => setF({ ...f, zone: e.target.value })}>{d.zones.map((z: any) => <option key={z.id} value={z.id}>{pick(z.name, lang)}</option>)}</select>
            <div className="addr-grid">
              <div><label htmlFor="bd">Tuman</label><input id="bd" value={f.district} onChange={(e) => setF({ ...f, district: e.target.value })} /></div>
              <div><label htmlFor="bs">Ko‘cha / mahalla</label><input id="bs" value={f.street} onChange={(e) => setF({ ...f, street: e.target.value })} /></div>
              <div><label htmlFor="bh">Uy</label><input id="bh" value={f.house} onChange={(e) => setF({ ...f, house: e.target.value })} /></div>
              <div><label htmlFor="bt">Qulay vaqt</label><input id="bt" value={f.contact_time} onChange={(e) => setF({ ...f, contact_time: e.target.value })} placeholder="Kechqurun" /></div>
            </div>
            <label className="check-row"><input type="checkbox" checked={f.terms} onChange={(e) => setF({ ...f, terms: e.target.checked })} /> <span><a href="/legal/offer" target="_blank">Ommaviy oferta</a>ga roziman</span></label>
            <div className="row">
              <button className="btn big" disabled={!okBuy || busy}>Buyurtma berish</button>
              <button type="button" className="btn secondary" onClick={() => { setMode('compare'); setPickSku(''); }}>Orqaga</button>
            </div>
          </form>
        </section>
      )}
    </div>
  );
}
