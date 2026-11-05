'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { errText } from '@/lib/errors';

/** "Narxi tushsa xabar bering": explicit consent, one SMS if the price drops, then the watch closes. */
export function PriceWatch({ productId }: { productId: string }) {
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const [consent, setConsent] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  if (done) return <p className="pw-done small">🔔 Narx tushsa, bir marta SMS yuboramiz.</p>;
  if (!open) return <button type="button" className="link-btn small pw-open" onClick={() => setOpen(true)}>🔔 Narxi tushsa xabar bering</button>;
  return (
    <div className="pw-box">
      <label htmlFor="pw-phone" className="small">Telefon raqamingiz</label>
      <input id="pw-phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="+998 90 123 45 67" value={phone} onChange={(e) => setPhone(e.target.value)} />
      <label className="s-check small"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> Narx tushganda bitta SMS olishga roziman</label>
      <button type="button" className="btn secondary sm" disabled={!consent || phone.replace(/\D/g, '').length < 9} onClick={async () => {
        setMsg(null);
        try { await api('/price-watch', { method: 'POST', body: { product_id: productId, phone, consent: true } }); setDone(true); }
        catch (e: any) { setMsg(e.code === 'PHONE_INVALID' ? 'Telefon raqami noto‘g‘ri (+998 bilan yozing).' : errText(e)); }
      }}>Kuzatishni yoqish</button>
      {msg && <div className="field-error small">{msg}</div>}
    </div>
  );
}
