'use client';
import { useCallback, useEffect, useState } from 'react';
import { Async } from '@/components/Header';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';

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
  const load = useCallback(async () => {
    try {
      const [c, l] = await Promise.all([api('/ops/queues'), api(`/ops/orders?queue=${queue}`)]);
      setCounts(c); setItems(l.items); setSt({ loading: false, error: null });
    } catch (e) { setSt({ loading: false, error: e }); }
  }, [queue]);
  useEffect(() => { void load(); }, [load]);
  const open = async (id: string) => { try { setSel(await api(`/ops/orders/${id}`)); } catch (e: any) { setMsg(e.code); } };
  const act = async (fn: () => Promise<any>) => { setMsg(null); try { await fn(); setMsg('OK'); if (sel) await open(sel.id); await load(); } catch (e: any) { setMsg(e.code ?? 'ERROR'); } };
  return (
    <>
      <h1>Operator xonasi</h1>
      <div className="row" role="tablist">{QUEUES.map(([k, l]) => <button key={k} role="tab" aria-selected={queue === k} className={`btn ${queue === k ? '' : 'secondary'}`} onClick={() => setQueue(k)}>{l} ({counts[k] ?? 0})</button>)}</div>
      {msg && <div className="notice" role="status">{msg}</div>}
      <Async loading={st.loading} error={st.error} onRetry={load}>
        <div className="table-wrap"><table><thead><tr><th>№</th><th>Kanal</th><th>Holat</th><th>Summa</th><th>Kechikish</th><th>Mas’ul</th></tr></thead><tbody>
          {items.map((o) => <tr key={o.id}><td><button className="btn secondary" onClick={() => open(o.id)}>{o.number}</button>{o.duplicate_signal && <span className="badge"> dublikat?</span>}</td><td>{o.channel}</td><td>{o.commercial_status} · {o.confirmation_status} · {o.fulfillment_status} · {o.payment_status}{o.problem_reason ? ` · ${o.problem_reason}` : ''}</td><td>{som(o.payable_minor)}</td><td>{Math.round(o.age_seconds / 60)} daq</td><td>{o.operator_name ?? '—'}</td></tr>)}
        </tbody></table></div>
      </Async>
      {sel && (
        <section className="card" style={{ marginTop: 12 }}>
          <div className="spread"><h2>{sel.number}</h2><button className="btn secondary" onClick={() => setSel(null)}>×</button></div>
          <p>{sel.contact_snapshot?.name} · <a href={`tel:${sel.customer_phone}`}>{sel.customer_phone}</a> · {sel.address_snapshot?.district}, {sel.address_snapshot?.street} {sel.address_snapshot?.house}</p>
          {sel.address_snapshot?.quick && <p className="notice">⚡ Tez buyurtma: mijoz faqat ism va telefon qoldirgan. Qo‘ng‘iroqda aniq manzilni so‘rab, pastda saqlang — manzilsiz tasdiqlab bo‘lmaydi.</p>}
          {!['shipped', 'delivered', 'returned'].includes(sel.fulfillment_status) && <AddressEditor order={sel} onSave={(address) => act(() => api(`/ops/orders/${sel.id}/address`, { method: 'PATCH', body: { expected_version: sel.version, address, reason: 'operator qo‘ng‘iroq' } }))} />}
          <p>Hamkor: {sel.partner_code ?? '—'} ({sel.attribution?.reason ?? '—'}) · Holat: {sel.commercial_status} / {sel.confirmation_status} / {sel.fulfillment_status} / {sel.payment_status}</p>
          {sel.lines.map((l: any) => <div key={l.id} className="spread"><span>{pick(l.product_snapshot.name, lang)} × {l.qty}</span><span>{som(l.line_net_minor)}</span></div>)}
          <div className="spread" style={{ fontWeight: 700 }}><span>Jami</span><span>{som(sel.payable_minor)}</span></div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn secondary" onClick={() => act(() => api(`/ops/orders/${sel.id}/claim`, { method: 'POST' }))}>Olish</button>
            <button className="btn" onClick={() => act(() => api(`/ops/orders/${sel.id}/calls`, { method: 'POST', body: { outcome: 'confirmed', confirmed_total_minor: sel.payable_minor, note: 'telefonda tasdiqladi' } }))}>Tasdiqladi ({som(sel.payable_minor)})</button>
            <button className="btn secondary" onClick={() => act(() => api(`/ops/orders/${sel.id}/calls`, { method: 'POST', body: { outcome: 'no_answer' } }))}>Javob bermadi</button>
            <button className="btn secondary" onClick={() => act(() => api(`/ops/orders/${sel.id}/calls`, { method: 'POST', body: { outcome: 'call_later' } }))}>Keyin</button>
            <button className="btn danger" onClick={() => act(() => api(`/ops/orders/${sel.id}/calls`, { method: 'POST', body: { outcome: 'rejected' } }))}>Rad etdi</button>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn secondary" onClick={() => act(() => api(`/ops/orders/${sel.id}/pick`, { method: 'POST' }))}>Yig‘ish</button>
            <button className="btn secondary" onClick={() => act(() => api(`/ops/orders/${sel.id}/pack`, { method: 'POST' }))}>Qadoqlandi</button>
            <input placeholder="Kuryer user id" value={courier} onChange={(e) => setCourier(e.target.value)} style={{ maxWidth: 320 }} />
            <button className="btn secondary" onClick={() => act(() => api(`/ops/orders/${sel.id}/ship`, { method: 'POST', body: { courier_user_id: courier } }))}>Kuryerga topshirish</button>
          </div>
          <h3>Timeline</h3>
          <ul>{sel.timeline.map((e: any) => <li key={e.id}>{new Date(e.created_at).toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent' })} · {e.dimension}: {e.from_status ?? '∅'} → {e.to_status} · {e.actor_name ?? e.actor_kind} {e.reason ? `(${e.reason})` : ''}</li>)}</ul>
          <h3>Qo‘ng‘iroqlar</h3>
          <ul>{sel.calls.map((c: any) => <li key={c.id}>{c.outcome} · {c.operator_name} · {c.note ?? ''}</li>)}</ul>
        </section>
      )}
    </>
  );
}

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
