'use client';
import { useCallback, useEffect, useState } from 'react';
import { Async } from '@/components/Header';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';

const BUCKETS: [string, string][] = [['estimated_minor', 'Taxminiy'], ['pending_minor', 'Kutilmoqda'], ['available_minor', 'Yechish mumkin'], ['reserved_minor', "To'lov so'rovida"], ['paid_minor', "To'langan"], ['debt_minor', 'Tuzatish (qarz)']];

export default function Partner() {
  const { lang } = useI18n();
  const [me, setMe] = useState<any>(null);
  const [products, setProducts] = useState<any[]>([]);
  const [links, setLinks] = useState<any[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [payouts, setPayouts] = useState<any[]>([]);
  const [zones, setZones] = useState<any[]>([]);
  const [st, setSt] = useState<{ loading: boolean; error: any }>({ loading: true, error: null });
  const [msg, setMsg] = useState<string | null>(null);
  const [po, setPo] = useState({ sku: '', qty: 1, name: '', phone: '', district: '', street: '', house: '', note: '' });
  const [quote, setQuote] = useState<any>(null);
  const [apply, setApply] = useState({ name: '', channels: '' });
  const load = useCallback(async () => {
    try {
      const m = await api('/partner/me');
      setMe(m);
      if (m.status === 'active' || m.status === 'suspended') {
        const [p, l, o, py, z] = await Promise.all([m.status === 'active' ? api('/partner/products') : { items: [] }, api('/partner/links'), api('/partner/orders'), api('/partner/payouts'), api('/delivery-zones')]);
        setProducts(p.items); setLinks(l.items); setOrders(o.items); setPayouts(py.items); setZones(z.items);
      }
      setSt({ loading: false, error: null });
    } catch (e: any) { if (e.code === 'PARTNER_NOT_FOUND') { setMe(null); setSt({ loading: false, error: null }); } else setSt({ loading: false, error: e }); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const act = async (fn: () => Promise<any>) => { setMsg(null); try { const r = await fn(); setMsg(typeof r === 'string' ? r : 'OK'); await load(); } catch (e: any) { setMsg(e.code ?? 'ERROR'); } };
  if (!st.loading && !st.error && !me) return (
    <div className="card" style={{ maxWidth: 520 }}>
      <h1>Hamkor bo‘lish</h1>
      {msg && <div className="notice" role="alert">{msg}</div>}
      <label htmlFor="dn">Ko‘rsatiladigan ism</label><input id="dn" value={apply.name} onChange={(e) => setApply({ ...apply, name: e.target.value })} />
      <label htmlFor="ch">Kanallar (Telegram, Instagram…)</label><input id="ch" value={apply.channels} onChange={(e) => setApply({ ...apply, channels: e.target.value })} />
      <p className="muted">Ariza yuborish bilan <a href="/legal/partner">hamkorlik shartnomasi</a>ni qabul qilasiz. Admin tasdiqlagandan so‘ng faol bo‘ladi.</p>
      <button className="btn" onClick={() => act(() => api('/partner/apply', { method: 'POST', body: { display_name: apply.name, channels: apply.channels, accept_agreement: true } }))}>Ariza yuborish</button>
    </div>
  );
  return (
    <Async loading={st.loading} error={st.error} onRetry={load}>
      {me && (
        <>
          <h1>Hamkor kabineti · <code>{me.code}</code> <span className="badge">{me.status}</span></h1>
          {msg && <div className="notice" role="status">{msg}</div>}
          <div className="grid">{BUCKETS.map(([k, label]) => <div key={k} className="card"><div className="muted">{label}</div><div style={{ fontWeight: 700 }}>{som(me.balances[k])}</div></div>)}</div>
          <p className="muted">Kutilmoqda → yetkazilib, to‘lov kassaga tushgach va kutish muddati o‘tgach «Yechish mumkin»ga o‘tadi.</p>
          {me.status === 'active' && (
            <section className="card" style={{ marginTop: 12 }}>
              <h2>Mahsulotlar va komissiya</h2>
              <div className="table-wrap"><table><tbody>{products.map((p) => (
                <tr key={p.id}><td>{pick(p.name, lang)}</td><td>{som(p.min_price_minor)}</td>
                  <td>{p.commission ? (p.commission.kind === 'percent' ? `${p.commission.rate_bps / 100}%` : `${som(p.commission.fixed_minor)} / dona`) : <span className="muted">Komissiya qoidasi yo‘q</span>}</td>
                  <td><button className="btn secondary" onClick={() => act(async () => { const r = await api('/partner/links', { method: 'POST', body: { product_id: p.id } }); await navigator.clipboard?.writeText(location.origin + '/r/' + r.code).catch(() => {}); return `Havola: ${location.origin}/r/${r.code}`; })}>Havola olish</button></td></tr>
              ))}</tbody></table></div>
            </section>
          )}
          <section className="card" style={{ marginTop: 12 }}>
            <h2>Havolalarim</h2>
            <div className="table-wrap"><table><thead><tr><th>Havola</th><th>Mahsulot</th><th>Bosishlar</th><th>Buyurtmalar</th></tr></thead><tbody>
              {links.map((l) => <tr key={l.id}><td><code>/r/{l.code}</code></td><td>{l.product_name ? pick(l.product_name, lang) : '—'}</td><td>{l.clicks}</td><td>{l.orders}</td></tr>)}
            </tbody></table></div>
          </section>
          {me.status === 'active' && (
            <section className="card" style={{ marginTop: 12 }}>
              <h2>Mijoz uchun buyurtma</h2>
              <p className="muted">Mijoz telefoniga SMS kod va havola boradi; mijoz o‘zi tasdiqlamaguncha buyurtma jo‘natilmaydi va komissiya hisoblanmaydi. Mijozning karta yoki bank kodlarini hech qachon so‘ramang.</p>
              <label htmlFor="psku">Mahsulot varianti (SKU id)</label>
              <select id="psku" value={po.sku} onChange={(e) => setPo({ ...po, sku: e.target.value })}><option value="">—</option>{products.map((p) => <ProductSkus key={p.id} slug={p.slug} name={pick(p.name, lang)} />)}</select>
              <label htmlFor="pq">Soni</label><input id="pq" type="number" min={1} value={po.qty} onChange={(e) => setPo({ ...po, qty: Number(e.target.value) || 1 })} />
              <label htmlFor="pn">Mijoz ismi</label><input id="pn" value={po.name} onChange={(e) => setPo({ ...po, name: e.target.value })} />
              <label htmlFor="pp">Mijoz telefoni</label><input id="pp" type="tel" value={po.phone} onChange={(e) => setPo({ ...po, phone: e.target.value })} />
              <label htmlFor="pd">Tuman</label><input id="pd" value={po.district} onChange={(e) => setPo({ ...po, district: e.target.value })} />
              <label htmlFor="ps">Ko‘cha</label><input id="ps" value={po.street} onChange={(e) => setPo({ ...po, street: e.target.value })} />
              <label htmlFor="ph">Uy</label><input id="ph" value={po.house} onChange={(e) => setPo({ ...po, house: e.target.value })} />
              <label htmlFor="pnote">Mijoz bilan kelishuv izohi</label><input id="pnote" value={po.note} onChange={(e) => setPo({ ...po, note: e.target.value })} />
              <div className="row" style={{ marginTop: 12 }}>
                <button className="btn secondary" onClick={() => act(async () => { setQuote(await api('/partner/orders/quote', { method: 'POST', body: { lines: [{ sku_id: po.sku, qty: po.qty }], delivery_zone_id: zones[0]?.id, address: { region_code: zones[0]?.region_code ?? 'TAS', district: po.district, street: po.street, house: po.house }, contact: { name: po.name, phone: po.phone } } })); return 'Hisoblandi'; })}>Hisoblash</button>
                {quote && <button className="btn" onClick={() => act(async () => { const r = await api('/partner/orders', { method: 'POST', idem: quote.quote_id, body: { quote_id: quote.quote_id, quote_hash: quote.quote_hash, payment_method: 'cod', customer_agreement_note: po.note || 'kelishildi' } }); setQuote(null); return `Yaratildi: ${r.number}. Mijoz ${r.customer_phone_masked} tasdiqlashini kutmoqda.`; })}>Yaratish · {som(quote.payable.amount_minor)}</button>}
              </div>
            </section>
          )}
          <section className="card" style={{ marginTop: 12 }}>
            <h2>Buyurtmalarim</h2>
            <div className="table-wrap"><table><thead><tr><th>№</th><th>Kanal</th><th>Holat</th><th>Komissiya</th></tr></thead><tbody>
              {orders.map((o) => <tr key={o.id}><td>{o.masked_number}</td><td>{o.channel}</td><td>{o.commercial_status} · {o.confirmation_status} · {o.fulfillment_status}</td><td>{som(o.commission_minor)} <span className="muted">{o.commission_state ?? ''}</span></td></tr>)}
            </tbody></table></div>
          </section>
          <section className="card" style={{ marginTop: 12 }}>
            <h2>Pul yechish</h2>
            <p>Rekvizit: {me.payout_destination ? `${me.payout_destination.masked} ${me.payout_destination.verified ? '✓ tasdiqlangan' : '(tasdiq kutilmoqda)'}` : 'kiritilmagan'}</p>
            <PayoutForms onAct={act} available={me.balances.available_minor} />
            <div className="table-wrap"><table><tbody>{payouts.map((p) => <tr key={p.id}><td>{new Date(p.created_at).toLocaleDateString('uz-UZ')}</td><td>{som(p.amount_minor)}</td><td>{p.status}</td><td>{p.paid_reference ?? p.reject_reason ?? ''}</td></tr>)}</tbody></table></div>
          </section>
        </>
      )}
    </Async>
  );
}

function ProductSkus({ slug, name }: { slug: string; name: string }) {
  const [skus, setSkus] = useState<any[]>([]);
  useEffect(() => { api(`/products/${slug}`).then((p) => setSkus(p.variants ?? [])).catch(() => {}); }, [slug]);
  return <>{skus.map((s) => <option key={s.sku_id} value={s.sku_id}>{name} — {Object.values(s.variant).join('/') || s.sku_code} ({s.available})</option>)}</>;
}

function PayoutForms({ onAct, available }: { onAct: (fn: () => Promise<any>) => void; available: string }) {
  const [d, setD] = useState({ holder: '', number: '' });
  const [amt, setAmt] = useState('');
  return (
    <div className="row" style={{ alignItems: 'flex-end' }}>
      <div><label htmlFor="dh">Karta egasi</label><input id="dh" value={d.holder} onChange={(e) => setD({ ...d, holder: e.target.value })} /></div>
      <div><label htmlFor="dn">Karta raqami</label><input id="dn" inputMode="numeric" value={d.number} onChange={(e) => setD({ ...d, number: e.target.value.replace(/\D/g, '') })} /></div>
      <button className="btn secondary" onClick={() => onAct(() => api('/partner/payout-destination', { method: 'PUT', body: { type: 'card', holder: d.holder, number: d.number } }))}>Saqlash</button>
      <div><label htmlFor="am">Summa (so‘m)</label><input id="am" inputMode="numeric" value={amt} onChange={(e) => setAmt(e.target.value.replace(/\D/g, ''))} /></div>
      <button className="btn" disabled={!amt} onClick={() => onAct(() => api('/partner/payouts', { method: 'POST', idem: crypto.randomUUID(), body: { amount_minor: String(BigInt(amt) * 100n) } }))}>So‘rov yuborish (mavjud: {som(available)})</button>
    </div>
  );
}
