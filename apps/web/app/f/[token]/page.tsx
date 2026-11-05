'use client';
import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';

/**
 * Customer fill link (V2 §05): the customer enters their own contact and address, then confirms by SMS code.
 * Opening the page changes nothing (messenger previews are safe); the link works once and expires.
 */
export default function CustomerFill({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const { lang } = useI18n();
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [f, setF] = useState({ name: '', phone: '', zone: '', district: '', street: '', house: '', apartment: '', landmark: '', contact_time: '', terms: false });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<any>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  useEffect(() => {
    api(`/fill/${token}`).then((r) => { setD(r); setF((x) => ({ ...x, zone: r.delivery_zone_id ?? r.zones?.[0]?.id ?? '' })); })
      .catch((e) => setErr(e.code === 'FILL_LINK_EXPIRED' ? 'expired' : 'gone'));
  }, [token]);
  const zone = d?.zones?.find((z: any) => z.id === f.zone);
  const ok = f.name.trim().length >= 2 && f.phone.replace(/\D/g, '').length >= 9 && f.zone && f.district.trim() && f.street.trim() && f.house.trim() && f.terms;

  if (err) return (
    <div className="card fill-card">
      <h1>{err === 'expired' ? 'Havola muddati tugagan' : 'Havola faol emas'}</h1>
      <p>{err === 'expired' ? 'Sizga havola yuborgan sotuvchidan yangisini so‘rang.' : 'Bu havola allaqachon ishlatilgan yoki bekor qilingan. Buyurtmangiz bo‘yicha sotuvchiga murojaat qiling.'}</p>
      <Link className="btn" href="/">Do‘konga o‘tish</Link>
    </div>
  );
  if (done) return (
    <div className="card fill-card">
      <div className="sd-icon" aria-hidden>📩</div>
      <h1>Rahmat! Buyurtmangiz qabul qilindi</h1>
      <p>Buyurtma <b>{done.order_number}</b> tayyorlandi. Tez orada UzShop operatori sizga qo‘ng‘iroq qilib tasdiqlaydi{done.next === 'confirm_by_sms' ? ' (telefoningizga SMS havola ham yuborildi)' : ''}.</p>
      {done.dev_customer_link_token && <p className="badge test">DEMO: <a href={`/confirm/${done.dev_customer_link_token}`}>tasdiqlash sahifasi</a> · kod <code>{done.dev_customer_code}</code></p>}
      <p className="muted small">Hech qachon karta ma’lumoti yoki bank SMS kodini hech kimga bermang.</p>
    </div>
  );
  if (!d) return <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>;
  return (
    <div className="card fill-card">
      <h1>Buyurtmangizni rasmiylashtiring</h1>
      <p className="muted">{d.shop_name} · to‘lov mahsulotni olganda</p>
      <div className="fill-lines">
        {d.lines.map((l: any) => <div key={l.sku_id} className="sum-row"><span>{pick(l.product?.name, lang)}{Object.values(l.product?.variant ?? {}).length ? ` (${Object.values(l.product.variant).join(' / ')})` : ''} × {l.qty}</span><b>{som(l.line_total.amount_minor)}</b></div>)}
        {zone && <div className="sum-row"><span>Yetkazish</span><b>{som(zone.tariff_minor)}</b></div>}
        <div className="sum-row total"><span>Jami</span><b>{som(String(BigInt(d.subtotal?.amount_minor ?? '0') + BigInt(zone?.tariff_minor ?? '0')))}</b></div>
        <p className="muted small">Yakuniy summani operator qo‘ng‘iroqda aytadi.</p>
      </div>
      {formErr && <div className="notice" role="alert">{formErr}</div>}
      <form onSubmit={async (e) => {
        e.preventDefault(); if (!ok) return; setBusy(true); setFormErr(null);
        try {
          setDone(await api(`/fill/${token}`, { method: 'POST', body: { name: f.name.trim(), phone: f.phone, delivery_zone_id: f.zone, address: { district: f.district.trim(), street: f.street.trim(), house: f.house.trim(), apartment: f.apartment || undefined, landmark: f.landmark || undefined }, contact_time: f.contact_time || undefined, accept_terms: true } }));
        } catch (er: any) { setFormErr(er.code === 'PHONE_INVALID' ? 'Telefon raqamini to‘g‘ri kiriting: +998 90 123 45 67' : er.code === 'OUT_OF_STOCK' ? 'Afsuski, mahsulot tugab qoldi.' : er.code === 'FILL_LINK_EXPIRED' ? 'Havola muddati tugagan.' : 'Xatolik. Qayta urinib ko‘ring.'); }
        finally { setBusy(false); }
      }}>
        <label htmlFor="fn">Ismingiz</label><input id="fn" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="name" required />
        <label htmlFor="fp">Telefon raqamingiz</label><input id="fp" type="tel" inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="+998 90 123 45 67" autoComplete="tel" required />
        <label htmlFor="fz">Hudud</label>
        <select id="fz" value={f.zone} onChange={(e) => setF({ ...f, zone: e.target.value })}>{d.zones.map((z: any) => <option key={z.id} value={z.id}>{pick(z.name, lang)}</option>)}</select>
        <div className="addr-grid">
          <div><label htmlFor="fd">Tuman</label><input id="fd" value={f.district} onChange={(e) => setF({ ...f, district: e.target.value })} required /></div>
          <div><label htmlFor="fs">Ko‘cha / mahalla</label><input id="fs" value={f.street} onChange={(e) => setF({ ...f, street: e.target.value })} required /></div>
          <div><label htmlFor="fh">Uy</label><input id="fh" value={f.house} onChange={(e) => setF({ ...f, house: e.target.value })} required /></div>
          <div><label htmlFor="fa">Xonadon</label><input id="fa" value={f.apartment} onChange={(e) => setF({ ...f, apartment: e.target.value })} /></div>
        </div>
        <label htmlFor="fl">Mo‘ljal</label><input id="fl" value={f.landmark} onChange={(e) => setF({ ...f, landmark: e.target.value })} />
        <label htmlFor="ft">Qachon qo‘ng‘iroq qilish qulay?</label><input id="ft" value={f.contact_time} onChange={(e) => setF({ ...f, contact_time: e.target.value })} placeholder="Masalan: kechqurun 18:00 dan keyin" />
        <label className="check-row"><input type="checkbox" checked={f.terms} onChange={(e) => setF({ ...f, terms: e.target.checked })} /> <span><a href="/legal/offer" target="_blank">Ommaviy oferta</a> va <a href="/legal/privacy" target="_blank">maxfiylik siyosati</a>ga roziman</span></label>
        <button className="btn big full" disabled={!ok || busy}>Davom etish</button>
      </form>
    </div>
  );
}
