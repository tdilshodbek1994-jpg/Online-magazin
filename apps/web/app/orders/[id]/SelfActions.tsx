'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { errText } from '@/lib/errors';
import { toast } from '@/lib/toast';

const REASONS = ['Fikrimdan qaytdim', 'Boshqa joydan oldim', 'Narx to‘g‘ri kelmadi', 'Yetkazish muddati uzoq', 'Xato buyurtma berdim'];

/** Customer actions on own order: share a minimal status link; cancel before the warehouse starts picking. */
export function SelfActions({ o, onChanged }: { o: any; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState(REASONS[0]!);
  const [busy, setBusy] = useState(false);
  const cancellable = o.commercial_status !== 'cancelled' && ['unallocated', 'reserved'].includes(o.fulfillment_status);
  const share = async () => {
    try {
      const r = await api(`/me/orders/${o.id}/status-link`, { method: 'POST' });
      const url = `${location.origin}${r.path}`;
      if (navigator.share) await navigator.share({ title: 'Buyurtma holati', url }).catch(() => {});
      else { await navigator.clipboard.writeText(url); toast('✓ Havola nusxalandi (30 kun amal qiladi)'); }
    } catch (e: any) { toast(errText(e), 'err'); }
  };
  const cancel = async () => {
    setBusy(true);
    try { await api(`/me/orders/${o.id}/cancel`, { method: 'POST', body: { reason, expected_version: undefined } }); toast('✓ Buyurtma bekor qilindi'); setOpen(false); onChanged(); }
    catch (e: any) { toast(e.code === 'ORDER_ALREADY_IN_FULFILMENT' ? 'Buyurtma allaqachon yig‘ilmoqda — bekor qilish uchun operatorga yozing.' : errText(e), 'err'); }
    finally { setBusy(false); }
  };
  return (
    <div className="ord-actions">
      <button className="btn secondary sm" onClick={share}>🔗 Holatni ulashish</button>
      {cancellable && !open && <button className="btn secondary sm danger-t" onClick={() => setOpen(true)}>Bekor qilish</button>}
      {open && (
        <div className="ord-cancel card">
          <b>Buyurtmani bekor qilasizmi?</b>
          <label className="small muted" htmlFor="cr">Sababi</label>
          <select id="cr" value={reason} onChange={(e) => setReason(e.target.value)}>{REASONS.map((r) => <option key={r}>{r}</option>)}</select>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn sm" disabled={busy} onClick={cancel}>Ha, bekor qilish</button>
            <button className="btn secondary sm" onClick={() => setOpen(false)}>Yo‘q</button>
          </div>
        </div>
      )}
    </div>
  );
}
