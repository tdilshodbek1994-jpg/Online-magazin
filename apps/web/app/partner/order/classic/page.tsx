'use client';
import { useEffect, useState } from 'react';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';

/** Partner enters an order for a customer; the customer confirms it themselves by SMS link before anything ships (§ partner_assisted). */
export default function PartnerAssistedOrder() {
  const { lang } = useI18n();
  const [products, setProducts] = useState<any[]>([]);
  const [zones, setZones] = useState<any[]>([]);
  const [po, setPo] = useState({ sku: '', qty: 1, name: '', phone: '', district: '', street: '', house: '', note: '' });
  const [quote, setQuote] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    api('/partner/products').then((p) => setProducts(p.items)).catch((e) => setMsg(e.code));
    api('/delivery-zones').then((z) => setZones(z.items)).catch(() => {});
  }, []);
  const act = async (fn: () => Promise<string>) => { setMsg(null); try { setMsg(await fn()); } catch (e: any) { setMsg(e.code ?? 'ERROR'); } };
  return (
    <div className="card" style={{ maxWidth: 640 }}>
      <h1>Mijoz uchun buyurtma</h1>
      <p className="muted">Mijoz telefoniga SMS kod va havola boradi; mijoz o‘zi tasdiqlamaguncha buyurtma jo‘natilmaydi va komissiya hisoblanmaydi. Mijozning karta yoki bank kodlarini hech qachon so‘ramang.</p>
      {msg && <div className="notice" role="status">{msg}</div>}
      <label htmlFor="psku">Mahsulot varianti</label>
      <select id="psku" value={po.sku} onChange={(e) => { setPo({ ...po, sku: e.target.value }); setQuote(null); }}><option value="">— tanlang —</option>{products.map((p) => <ProductSkus key={p.id} slug={p.slug} name={pick(p.name, lang)} />)}</select>
      <label htmlFor="pq">Soni</label><input id="pq" type="number" min={1} value={po.qty} onChange={(e) => { setPo({ ...po, qty: Number(e.target.value) || 1 }); setQuote(null); }} />
      <label htmlFor="pn">Mijoz ismi</label><input id="pn" value={po.name} onChange={(e) => setPo({ ...po, name: e.target.value })} />
      <label htmlFor="pp">Mijoz telefoni</label><input id="pp" type="tel" value={po.phone} onChange={(e) => setPo({ ...po, phone: e.target.value })} placeholder="+998 90 123 45 67" />
      <label htmlFor="pd">Tuman</label><input id="pd" value={po.district} onChange={(e) => setPo({ ...po, district: e.target.value })} />
      <label htmlFor="ps">Ko‘cha</label><input id="ps" value={po.street} onChange={(e) => setPo({ ...po, street: e.target.value })} />
      <label htmlFor="ph">Uy</label><input id="ph" value={po.house} onChange={(e) => setPo({ ...po, house: e.target.value })} />
      <label htmlFor="pnote">Mijoz bilan kelishuv izohi</label><input id="pnote" value={po.note} onChange={(e) => setPo({ ...po, note: e.target.value })} />
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn secondary" disabled={!po.sku} onClick={() => act(async () => { setQuote(await api('/partner/orders/quote', { method: 'POST', body: { lines: [{ sku_id: po.sku, qty: po.qty }], delivery_zone_id: zones[0]?.id, address: { region_code: zones[0]?.region_code ?? 'TAS', district: po.district, street: po.street, house: po.house }, contact: { name: po.name, phone: po.phone } } })); return 'Hisoblandi'; })}>Hisoblash</button>
        {quote && <button className="btn" onClick={() => act(async () => { const r = await api('/partner/orders', { method: 'POST', idem: quote.quote_id, body: { quote_id: quote.quote_id, quote_hash: quote.quote_hash, payment_method: 'cod', customer_agreement_note: po.note || 'kelishildi' } }); setQuote(null); return `Yaratildi: ${r.number}. Mijoz ${r.customer_phone_masked} tasdiqlashini kutmoqda.`; })}>Yaratish · {som(quote.payable.amount_minor)}</button>}
      </div>
    </div>
  );
}

function ProductSkus({ slug, name }: { slug: string; name: string }) {
  const [skus, setSkus] = useState<any[]>([]);
  useEffect(() => { api(`/products/${slug}`).then((p) => setSkus(p.variants ?? [])).catch(() => {}); }, [slug]);
  return <>{skus.map((s) => <option key={s.sku_id} value={s.sku_id}>{name} — {Object.values(s.variant).join('/') || s.sku_code} ({s.available})</option>)}</>;
}
