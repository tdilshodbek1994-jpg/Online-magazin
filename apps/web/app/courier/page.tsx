'use client';
import { useCallback, useEffect, useState } from 'react';
import { Async } from '@/components/Header';
import { api, som } from '@/lib/api';

export default function Courier() {
  const [items, setItems] = useState<any[]>([]);
  const [st, setSt] = useState<{ loading: boolean; error: any }>({ loading: true, error: null });
  const [sel, setSel] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(async () => { try { setItems((await api('/courier/tasks')).items); setSt({ loading: false, error: null }); } catch (e) { setSt({ loading: false, error: e }); } }, []);
  useEffect(() => { void load(); }, [load]);
  const act = async (fn: () => Promise<any>) => { setMsg(null); try { await fn(); setMsg('OK'); await load(); } catch (e: any) { setMsg(e.code); } };
  return (
    <>
      <h1>Kuryer vazifalari</h1>
      {msg && <div className="notice" role="status">{msg}</div>}
      <Async loading={st.loading} error={st.error} onRetry={load}>
        {items.map((o) => (
          <div key={o.id} className="card" style={{ marginBottom: 8 }}>
            <div className="spread"><strong>{o.number}</strong><span>{o.cod_amount_minor ? `COD: ${som(o.cod_amount_minor)}` : 'Oldindan to‘langan'}</span></div>
            <p>{o.recipient} · <a href={`tel:${o.phone}`}>{o.phone}</a><br />{o.address_snapshot.district}, {o.address_snapshot.street} {o.address_snapshot.house} {o.address_snapshot.landmark ?? ''}</p>
            <div className="row">
              <button className="btn" onClick={() => { const c = prompt('Qabul tasdig‘i (OTP/izoh)'); if (c) act(() => api(`/courier/orders/${o.id}/deliver`, { method: 'POST', body: { proof: { method: 'otp', value: c } } })); }}>Yetkazildi</button>
              <button className="btn secondary" onClick={() => { const r = prompt('Sabab'); if (r) act(() => api(`/courier/orders/${o.id}/fail`, { method: 'POST', body: { reason: r } })); }}>Muvaffaqiyatsiz urinish</button>
            </div>
          </div>
        ))}
      </Async>
      <h2>Kassaga topshirish</h2>
      <p className="muted">Yetkazilgan COD buyurtmalar ID’larini vergul bilan kiriting.</p>
      <input value={sel.join(',')} onChange={(e) => setSel(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} />
      <button className="btn" style={{ marginTop: 8 }} onClick={() => { const v = prompt('Topshirilayotgan naqd summa (so‘m)'); if (v) act(() => api('/courier/remittances', { method: 'POST', body: { order_ids: sel, declared_minor: String(BigInt(v.replace(/\D/g, '')) * 100n) } })); }}>Topshirish</button>
    </>
  );
}
