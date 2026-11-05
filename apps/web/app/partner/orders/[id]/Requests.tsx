'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errText } from '@/lib/errors';

/** "Operatorga yozish" on the sales passport: the partner asks instead of editing a submitted order (spec §08). */
const KINDS: [string, string][] = [['message', 'Mas’ulga xabar'], ['callback_time', 'Qo‘ng‘iroq vaqtini o‘zgartirish'], ['address', 'Manzilni to‘ldirish'], ['variant_change', 'Variantni almashtirish'], ['commission_question', 'Komissiya savoli']];
const KIND_UZ = Object.fromEntries(KINDS);
const fmt = (v: string) => new Date(v).toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export function PartnerRequests({ orderId }: { orderId: string }) {
  const [items, setItems] = useState<any[]>([]);
  const [msgs, setMsgs] = useState<any[]>([]);
  const [kind, setKind] = useState('message');
  const [body, setBody] = useState('');
  const [when, setWhen] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { api(`/partner/orders/${orderId}/requests`).then((r) => { setItems(r.items); setMsgs(r.messages ?? []); }).catch(() => {}); }, [orderId]);
  useEffect(load, [load]);
  const send = async () => {
    setBusy(true); setMsg(null);
    try {
      await api(`/partner/orders/${orderId}/requests`, { method: 'POST', body: { kind, body, preferred_at: when ? new Date(`${when}:00+05:00`).toISOString() : undefined } });
      setBody(''); setWhen(''); setMsg('✓ Yuborildi — operator javob beradi, javob shu yerda ko‘rinadi.'); load();
    } catch (e: any) { setMsg(e.code === 'PREFERRED_TIME_REQUIRED' ? 'Qo‘ng‘iroq vaqtini tanlang.' : errText(e)); } finally { setBusy(false); }
  };
  return (
    <section className="card preq" aria-labelledby="preq-h">
      <h2 id="preq-h">Operatorga yozish</h2>
      <p className="muted small">Yuborilgan buyurtmani o‘zingiz o‘zgartira olmaysiz — so‘rov yozing, operator bajaradi.</p>
      {msgs.length > 0 && <ul className="preq-list">{msgs.map((m, i) => <li key={i}><b className="small">💬 Operator xabari</b><div className="small">{m.body}</div><div className="muted small">{fmt(m.created_at)}</div></li>)}</ul>}
      <label htmlFor="preq-kind">Nima kerak?</label>
      <select id="preq-kind" value={kind} onChange={(e) => setKind(e.target.value)}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      {kind === 'callback_time' && (<><label htmlFor="preq-when">Mijozga qachon qo‘ng‘iroq qilinsin? (Toshkent vaqti)</label><input id="preq-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></>)}
      <label htmlFor="preq-body">Matn</label>
      <textarea id="preq-body" rows={3} maxLength={1000} value={body} onChange={(e) => setBody(e.target.value)} placeholder={kind === 'address' ? 'Masalan: Chilonzor 9-kvartal, 12-uy, 45-xonadon' : 'Qisqa yozing'} />
      <button className="btn full mt8" disabled={busy || body.trim().length < 3} onClick={send}>Yuborish</button>
      {msg && <div className="notice" role="status">{msg}</div>}
      {items.length > 0 && (
        <ul className="preq-list">
          {items.map((r) => (
            <li key={r.id}>
              <div className="spread"><b className="small">{KIND_UZ[r.kind] ?? r.kind}</b><span className={`pill ${r.status === 'answered' ? 'b-delivered' : 'b-accepted'}`}>{r.status === 'answered' ? 'Javob berildi' : 'Kutilmoqda'}</span></div>
              <div className="small">{r.body}{r.preferred_at ? ` · 📞 ${fmt(r.preferred_at)}` : ''}</div>
              {r.answer && <div className="preq-ans small">💬 {r.answer}</div>}
              <div className="muted small">{fmt(r.created_at)}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
