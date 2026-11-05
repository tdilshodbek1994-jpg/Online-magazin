'use client';
import { PickScan } from './PickScan';
import { useCallback, useEffect, useState } from 'react';
import { Async } from '@/components/Header';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';
import { errText } from '@/lib/errors';
import { toast } from '@/lib/toast';
import { WorkDesk } from './WorkDesk';
import { PartnerDiscountWarn } from '@/components/PartnerDiscountWarn';
import { TgAppConnect } from '@/components/TgAppConnect';

const QUEUES: [string, string][] = [['new', 'Yangi'], ['awaiting_customer', 'Mijoz tasdig‘i'], ['callback', 'Qayta qo‘ng‘iroq'], ['awaiting_payment', 'To‘lov kutilmoqda'], ['ready_to_pick', 'Yig‘ishga tayyor'], ['in_delivery', 'Yetkazishda'], ['problem', 'Muammoli'], ['returns', 'Qaytarish'], ['closed', 'Yopilgan']];

export default function Ops() {
  const { lang } = useI18n();
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [queue, setQueue] = useState('new');
  const [items, setItems] = useState<any[]>([]);
  const [sel, setSel] = useState<any>(null);
  const [st, setSt] = useState<{ loading: boolean; error: any }>({ loading: true, error: null });
  const [msg, setMsg] = useState<string | null>(null);
  const [courier, setCourier] = useState('');
  const [couriers, setCouriers] = useState<any[]>([]);
  useEffect(() => { api('/ops/couriers').then((r) => setCouriers(r.items)).catch(() => {}); }, []);
  const load = useCallback(async () => {
    try {
      const [c, l] = await Promise.all([api('/ops/queues'), api(`/ops/orders?queue=${queue}`)]);
      setCounts(c); setItems(l.items); setSt({ loading: false, error: null });
    } catch (e) { setSt({ loading: false, error: e }); }
  }, [queue]);
  useEffect(() => { void load(); }, [load]);
  const open = async (id: string) => { try { setSel(await api(`/ops/orders/${id}`)); } catch (e: any) { setMsg(errText(e)); } };
  // Deep link from the owner overview: /ops?order=<id> opens that order card.
  useEffect(() => { try { const id = new URLSearchParams(location.search).get('order'); if (id && /^[0-9a-f-]{36}$/.test(id)) void open(id); } catch {} }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Every tap answers on top of the screen (the sheet covers the page, so an inline notice would be invisible).
  const act = async (fn: () => Promise<any>, ok = '✓ Saqlandi') => { setMsg(null); try { await fn(); toast(ok); if (sel) await open(sel.id); await load(); } catch (e: any) { toast(errText(e), 'err'); } };
  return (
    <>
      <div className="spread"><h1>Operator xonasi</h1><a href="/ops/board" className="btn secondary sm">Rahbar paneli</a></div>
      <WorkDesk onChanged={() => void load()} />
      <h2 className="ops-h2">Barcha navbatlar</h2>
      <div className="chips ops-queues" role="tablist">{QUEUES.map(([k, l]) => <button key={k} role="tab" aria-selected={queue === k} className={`chip ${queue === k ? 'on' : ''}`} onClick={() => setQueue(k)}>{l} <span className="q-count">{counts[k] ?? 0}</span></button>)}</div>
      {msg && <div className="notice" role="status">{msg}</div>}
      <Async loading={st.loading} error={st.error} onRetry={load}>
        {items.length === 0 && <div className="empty">Bu navbatda buyurtma yo‘q 🎉</div>}
        <div className="slist">
          {items.map((o) => (
            <button key={o.id} type="button" className={`scard ops-card ${sel?.id === o.id ? 'sel' : ''}`} onClick={() => open(o.id)}>
              <div className="spread">
                <b>{o.number}</b>
                <span className="row" style={{ gap: 6 }}>
                  {o.quick_pending && <span className="pill b-shipping">⚡ manzil yo‘q</span>}
                  {o.partner_discount_minor && o.partner_discount_minor !== '0' && <span className="pill b-returned">🎁 chegirma −{som(o.partner_discount_minor)}</span>}
                  {o.duplicate_signal && <span className="pill b-returned">⚠️ dublikat</span>}
                  {o.callback_at && <span className="pill b-accepted">📞 {new Date(o.callback_at).toLocaleTimeString('uz-UZ', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tashkent' })}</span>}
                  <span className="pill">{CHANNEL_UZ[o.channel] ?? o.channel}</span>
                </span>
              </div>
              <div className="small">{o.customer_name ?? '—'} · {o.customer_phone} {o.district ? `· ${o.district}` : ''}</div>
              <div className="small muted">{o.items_text}</div>
              <div className="spread small"><b>{som(o.payable_minor)} <span className="muted">{o.payment_method === 'cod' ? 'naqd' : 'onlayn'}</span></b><span className="muted">⏱ {age(o.age_seconds)} · {o.operator_name ?? 'egasiz'}</span></div>
            </button>
          ))}
        </div>
      </Async>
      {sel && (
        <div className="sheet-backdrop" onClick={() => setSel(null)}>
          <section className="sheet ops-sheet" role="dialog" aria-modal="true" aria-label={`Buyurtma ${sel.number}`} onClick={(e) => e.stopPropagation()}>
            <div className="spread"><h2>{sel.number}</h2><button className="icon-btn" aria-label="Yopish" onClick={() => setSel(null)}>✕</button></div>
            <div className="req-grid">
              <div><span>Mijoz</span>{sel.contact_snapshot?.name ?? '—'}</div>
              <div><span>Telefon</span><a href={`tel:${sel.customer_phone}`} className="call-link">📞 {sel.customer_phone}</a></div>
              <div><span>Manzil</span>{[sel.address_snapshot?.district, sel.address_snapshot?.street, sel.address_snapshot?.house].filter((x) => x && x !== '-').join(', ') || '—'}</div>
              <div><span>Hamkor</span>{sel.partner_name ? `${sel.partner_name} (${sel.partner_code})` : '—'}</div>
            </div>
            <div className="pills"><span className="pill">{STATUS_UZ[sel.commercial_status] ?? sel.commercial_status}</span><span className="pill">{FUL_UZ[sel.fulfillment_status] ?? sel.fulfillment_status}</span><span className="pill">{sel.payment_method === 'cod' ? 'Naqd' : 'Onlayn'} · {PAY_UZ[sel.payment_status] ?? sel.payment_status}</span></div>
            {sel.address_snapshot?.quick && sel.address_snapshot?.house === '-' && <p className="notice">⚡ Tez buyurtma: qo‘ng‘iroqda aniq manzilni so‘rab, pastda saqlang — manzilsiz tasdiqlab bo‘lmaydi.</p>}
            {!['shipped', 'delivered', 'returned'].includes(sel.fulfillment_status) && <AddressEditor order={sel} onSave={(address) => act(() => api(`/ops/orders/${sel.id}/address`, { method: 'PATCH', body: { expected_version: sel.version, address, reason: 'operator qo‘ng‘iroq' } }), '✓ Manzil saqlandi')} />}
            <PartnerDiscountWarn lines={sel.lines} lang={lang} />
            <div className="ops-lines">
              {sel.lines.map((l: any) => <div key={l.id} className="spread small"><span>{pick(l.product_snapshot.name, lang)}{l.product_snapshot.variant && Object.values(l.product_snapshot.variant).length ? ` (${Object.values(l.product_snapshot.variant).join('/')})` : ''} × {sel.commercial_status === 'cancelled' ? l.qty : l.qty - (l.canceled_qty ?? 0)}</span><span>{som(l.line_net_minor)}</span></div>)}
              <div className="spread" style={{ fontWeight: 700 }}><span>Jami (yetkazish bilan)</span><span>{som(sel.payable_minor)}</span></div>
            </div>
            {sel.commercial_status === 'awaiting_confirmation' && (
              <div className="ops-actions">
                <b>Qo‘ng‘iroq natijasi</b>
                {!sel.assigned_operator_id && <button className="btn secondary" onClick={() => act(() => api(`/ops/orders/${sel.id}/claim`, { method: 'POST' }), '✓ Buyurtma sizga olindi')}>Buyurtmani olish</button>}
                <button className="btn big" onClick={() => act(() => api(`/ops/orders/${sel.id}/calls`, { method: 'POST', body: { outcome: 'confirmed', confirmed_total_minor: sel.payable_minor, note: 'telefonda tasdiqladi' } }), '✅ Tasdiqlandi — buyurtma omborga o‘tdi')}>✅ Tasdiqladi — {som(sel.payable_minor)}</button>
                <div className="ops-grid">
                  <button className="btn secondary" onClick={() => act(() => api(`/ops/orders/${sel.id}/calls`, { method: 'POST', body: { outcome: 'no_answer' } }), '✓ «Javob bermadi» yozildi')}>Javob bermadi</button>
                  <button className="btn secondary" onClick={() => act(() => api(`/ops/orders/${sel.id}/calls`, { method: 'POST', body: { outcome: 'call_later' } }), '✓ Keyinroq qo‘ng‘iroq qilish yozildi')}>Keyin qo‘ng‘iroq</button>
                  <button className="btn danger" onClick={() => { if (confirm('Mijoz rad etdimi? Buyurtma bekor qilinadi.')) act(() => api(`/ops/orders/${sel.id}/calls`, { method: 'POST', body: { outcome: 'rejected' } }), '✓ Rad etildi — buyurtma bekor qilindi'); }}>Rad etdi</button>
                </div>
              </div>
            )}
            {sel.commercial_status === 'confirmed' && ['reserved', 'picking', 'packed', 'unallocated'].includes(sel.fulfillment_status) && (
              <div className="ops-actions">
                <b>Ombor va yetkazish</b>
                <div className="ops-grid">
                  <button className="btn secondary" disabled={sel.fulfillment_status !== 'reserved'} onClick={() => act(() => api(`/ops/orders/${sel.id}/pick`, { method: 'POST' }), '✓ Yig‘ish boshlandi')}>1. Yig‘ishni boshlash</button>
                  <button className="btn secondary" disabled={sel.fulfillment_status !== 'picking'} onClick={() => act(() => api(`/ops/orders/${sel.id}/pack`, { method: 'POST' }), '✓ Qadoqlandi')}>2. Qadoqlandi</button>
                </div>
                {sel.fulfillment_status === 'picking' && <PickScan key={sel.id} orderId={sel.id} />}
                <label htmlFor="courier-sel">3. Kuryer</label>
                <select id="courier-sel" value={courier} onChange={(e) => setCourier(e.target.value)}><option value="">— kuryerni tanlang —</option>{couriers.map((c) => <option key={c.id} value={c.id}>{c.display_name ?? c.phone_e164}</option>)}</select>
                <button className="btn" disabled={!courier || sel.fulfillment_status !== 'packed'} onClick={() => act(() => api(`/ops/orders/${sel.id}/ship`, { method: 'POST', body: { courier_user_id: courier } }), '🚚 Kuryerga topshirildi')}>🚚 Kuryerga topshirish</button>
              </div>
            )}
            {['awaiting_confirmation', 'confirmed'].includes(sel.commercial_status) && !['shipped', 'delivered'].includes(sel.fulfillment_status) && (
              <details><summary className="muted small">Buyurtmani bekor qilish</summary>
                <div className="row" style={{ gap: 8, marginTop: 8 }}>
                  {[['customer_request', 'Mijoz so‘radi'], ['no_contact', 'Bog‘lanib bo‘lmadi'], ['duplicate', 'Dublikat'], ['out_of_stock', 'Mahsulot tugagan'], ['fraud_suspected', 'Shubhali']].map(([k, l]) => <button key={k} className="btn danger sm" onClick={() => { if (confirm(`Bekor qilinsinmi: ${l}?`)) act(() => api(`/ops/orders/${sel.id}/cancel`, { method: 'POST', body: { reason: k } })); }}>{l}</button>)}
                </div>
              </details>
            )}
            <details><summary className="muted small">Tarix ({sel.timeline.length}) va qo‘ng‘iroqlar ({sel.calls.length})</summary>
              <ul className="small hist-list">{sel.timeline.map((e: any) => <li key={e.id}><span className="muted">{when(e.created_at)}</span> {histText(e)} <span className="muted">· {e.actor_name ?? (e.actor_kind === 'anonymous' ? 'mijoz (sayt)' : e.actor_kind === 'system' ? 'tizim' : e.actor_kind === 'partner' ? 'hamkor' : e.actor_kind === 'customer' ? 'mijoz' : 'xodim')}</span></li>)}</ul>
              <ul className="small hist-list">{sel.calls.map((c: any) => <li key={c.id}><span className="muted">{when(c.created_at)}</span> 📞 {CALL_UZ[c.outcome] ?? 'natija yozildi'} <span className="muted">· {c.operator_name}</span>{c.note ? ` · ${c.note}` : ''}</li>)}</ul>
            </details>
          </section>
        </div>
      )}
      <TgAppConnect app="operator" />
    </>
  );
}

const CHANNEL_UZ: Record<string, string> = { web: 'Sayt', partner_assisted: 'Hamkor kiritgan', operator: 'Operator' };
const STATUS_UZ: Record<string, string> = { awaiting_confirmation: 'Tasdiq kutilmoqda', confirmed: 'Tasdiqlangan', cancelled: 'Bekor qilingan', completed: 'Yakunlangan', draft: 'Qoralama' };
const FUL_UZ: Record<string, string> = { unallocated: 'Ajratilmagan', reserved: 'Band qilingan', picking: 'Yig‘ilmoqda', packed: 'Qadoqlangan', shipped: 'Kuryerda', delivered: 'Yetkazildi', failed: 'Yetkazilmadi', returned: 'Qaytdi' };
const PAY_UZ: Record<string, string> = { unpaid: 'to‘lanmagan', pending: 'kutilmoqda', paid: 'to‘langan', partially_refunded: 'qisman qaytarilgan', refunded: 'qaytarilgan', unknown: 'noma’lum' };
const CALL_UZ: Record<string, string> = { wrong_data: 'Ma’lumot noto‘g‘ri', confirmed: 'Tasdiqladi', no_answer: 'Javob bermadi', call_later: 'Keyin qo‘ng‘iroq', rejected: 'Rad etdi', busy: 'Band', wrong_number: 'Noto‘g‘ri raqam', callback_requested: 'Keyin qo‘ng‘iroq so‘radi', info_given: 'Ma’lumot berildi', problem: 'Muammo' };
const REASON_UZ: Record<string, string> = { operator_call: 'operator qo‘ng‘irog‘i', call_confirmed: 'telefonda tasdiqladi', delivered: 'yetkazildi', returned: 'qaytdi', order_created: 'buyurtma tushdi', customer_request: 'mijoz so‘radi', no_contact: 'bog‘lanib bo‘lmadi', duplicate: 'dublikat', out_of_stock: 'mahsulot tugagan', fraud_suspected: 'shubhali', operator_confirmed: 'operator tasdiqladi', customer_rejected: 'mijoz rad etdi' };
const when = (t: string) => t ? new Date(t).toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
/** One history row in plain Uzbek: "Bekor qilindi (bog‘lanib bo‘lmadi)" instead of "commercial: awaiting_confirmation → cancelled (no_contact)". */
function histText(e: any): string {
  const map = e.dimension === 'fulfillment' ? FUL_UZ : e.dimension === 'payment' ? PAY_UZ : STATUS_UZ;
  const to = map[e.to_status] ?? 'yangilandi';
  const label = e.dimension === 'payment' ? `To‘lov: ${to}` : e.dimension === 'fulfillment' ? `Ombor: ${to}` : (e.from_status ? to : 'Yangi buyurtma');
  const r = e.reason ? (REASON_UZ[e.reason] ?? '') : '';
  return r && !(label === 'Yangi buyurtma' && e.reason === 'order_created') ? `${label} (${r})` : label;
}
const age = (s: number) => (s < 3600 ? `${Math.max(1, Math.round(s / 60))} daq` : s < 86400 ? `${Math.round(s / 3600)} soat` : `${Math.round(s / 86400)} kun`);

function AddressEditor({ order, onSave }: { order: any; onSave: (a: Record<string, string>) => void }) {
  const a = order.address_snapshot ?? {};
  const quickPending = a.quick && a.house === '-';
  const [open, setOpen] = useState<boolean>(!!quickPending);
  const [f, setF] = useState({ district: a.district === 'Aniqlanadi' ? '' : a.district ?? '', street: quickPending ? '' : a.street ?? '', house: quickPending ? '' : a.house ?? '', apartment: a.apartment ?? '', landmark: a.landmark ?? '' });
  if (!open) return <button className="btn secondary" onClick={() => setOpen(true)}>Manzilni tahrirlash</button>;
  const fields: [keyof typeof f, string][] = [['district', 'Tuman'], ['street', 'Ko‘cha'], ['house', 'Uy'], ['apartment', 'Xonadon'], ['landmark', 'Mo‘ljal']];
  return (
    <div className="card" style={{ marginTop: 8 }}>
      <b>Yetkazish manzili</b>
      <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
        {fields.map(([k, l]) => <div key={k}><label htmlFor={`ad-${k}`}>{l}</label><input id={`ad-${k}`} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></div>)}
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn" disabled={!f.district || !f.street || !f.house} onClick={() => onSave(Object.fromEntries(Object.entries(f).filter(([, v]) => v)))}>Manzilni saqlash</button>
        {!quickPending && <button className="btn secondary" onClick={() => setOpen(false)}>Bekor</button>}
      </div>
    </div>
  );
}
