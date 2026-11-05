'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { errText } from '@/lib/errors';
import { pick, useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';

const REASONS = ['Nuqsonli / ishlamayapti', 'Rasmdagidan farq qiladi', 'O‘lchami / rangi to‘g‘ri kelmadi', 'Noto‘g‘ri tovar keldi', 'Kerak bo‘lmay qoldi'];
const WANT: [string, string][] = [['refund', 'Pulimni qaytaring'], ['exchange', 'Almashtirib bering'], ['repair', 'Ta’mirlab bering']];

/** Customer return request for a delivered order: which items, how many, why, what they want. */
export function ReturnForm({ o, onDone }: { o: any; onDone: () => void }) {
  const { lang } = useI18n();
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [reason, setReason] = useState(REASONS[0]!);
  const [note, setNote] = useState('');
  const [want, setWant] = useState('refund');
  const [busy, setBusy] = useState(false);
  if (o.fulfillment_status !== 'delivered') return null;
  const lines = o.lines.filter((l: any) => l.qty - l.canceled_qty - l.returned_qty > 0);
  if (!lines.length) return null;
  const chosen = Object.entries(qty).filter(([, n]) => n > 0);
  const send = async () => {
    setBusy(true);
    try {
      await api('/returns', { method: 'POST', body: { order_id: o.id, lines: chosen.map(([id, n]) => ({ order_line_id: id, qty: n })), reason: note.trim() ? `${reason}. ${note.trim()}` : reason, desired_resolution: want } });
      toast('✓ Qaytarish so‘rovi yuborildi. Operator bog‘lanadi.'); setOpen(false); setQty({}); onDone();
    } catch (e: any) { toast(e.code === 'RETURN_QTY_EXCEEDS_DELIVERED' ? 'Bu tovar uchun qaytarish allaqachon ochilgan yoki soni ko‘p.' : errText(e), 'err'); }
    finally { setBusy(false); }
  };
  if (!open) return <button className="btn secondary sm" onClick={() => setOpen(true)}>↩️ Qaytarish yoki almashtirish</button>;
  return (
    <div className="card ret-form">
      <b>Qaysi tovarni qaytarasiz?</b>
      {lines.map((l: any) => { const max = l.qty - l.canceled_qty - l.returned_qty; const n = qty[l.id] ?? 0; return (
        <div key={l.id} className="ret-line"><span>{pick(l.product_snapshot.name, lang)}</span>
          <span className="ret-qty"><button type="button" aria-label="Kamaytirish" onClick={() => setQty({ ...qty, [l.id]: Math.max(0, n - 1) })}>−</button><b>{n}</b><button type="button" aria-label="Ko‘paytirish" onClick={() => setQty({ ...qty, [l.id]: Math.min(max, n + 1) })}>+</button><small className="muted">/ {max}</small></span></div>
      ); })}
      <label className="small muted" htmlFor="rr">Sababi</label>
      <select id="rr" value={reason} onChange={(e) => setReason(e.target.value)}>{REASONS.map((r) => <option key={r}>{r}</option>)}</select>
      <textarea rows={2} placeholder="Qo‘shimcha izoh (ixtiyoriy)" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      <div className="chips" role="group" aria-label="Nima istaysiz">{WANT.map(([k, l]) => <button key={k} type="button" className={`chip ${want === k ? 'on' : ''}`} aria-pressed={want === k} onClick={() => setWant(k)}>{l}</button>)}</div>
      <p className="muted small">Tovar qaytgani — pul qaytgani degani emas: pul qaytarish tovar tekshirilgandan keyin alohida bajariladi va holati shu yerda ko‘rinadi. Qaytarish shartlari: <a href="/legal/returns">o‘qish</a>.</p>
      <div className="row" style={{ gap: 8 }}><button className="btn sm" disabled={busy || !chosen.length} onClick={send}>Yuborish</button><button className="btn secondary sm" onClick={() => setOpen(false)}>Bekor</button></div>
    </div>
  );
}
