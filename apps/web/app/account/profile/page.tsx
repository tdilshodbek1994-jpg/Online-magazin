'use client';
import { useEffect, useState } from 'react';
import { api, setToken } from '@/lib/api';
import { errText } from '@/lib/errors';
import { toast } from '@/lib/toast';

/** Phone change (codes to BOTH the current and the new phone) and data copy/deletion requests. */
export default function Profile() {
  const [phone, setPhone] = useState('');
  const [ch, setCh] = useState<any>(null);
  const [c1, setC1] = useState('');
  const [c2, setC2] = useState('');
  const [reqs, setReqs] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const loadReqs = () => api('/me/data-requests').then((r) => setReqs(r.items)).catch(() => {});
  useEffect(() => { void loadReqs(); }, []);
  const start = async () => {
    setBusy(true);
    try { setCh(await api('/me/phone/change', { method: 'POST', body: { new_phone: phone } })); }
    catch (e: any) { toast(e.code === 'PHONE_IN_USE' ? 'Bu raqam boshqa hisobga ulangan.' : e.code === 'PHONE_SAME' ? 'Bu hozirgi raqamingiz.' : errText(e), 'err'); }
    finally { setBusy(false); }
  };
  const confirm = async () => {
    setBusy(true);
    try {
      await api('/me/phone/change/confirm', { method: 'POST', body: { current_challenge_id: ch.current.challenge_id, current_code: c1, new_challenge_id: ch.new.challenge_id, new_code: c2 } });
      toast('✓ Raqam almashtirildi. Yangi raqam bilan qayta kiring.');
      setToken(null); setTimeout(() => { location.href = '/login'; }, 1200);
    } catch (e: any) { toast(e.code === 'OTP_INVALID_OR_EXPIRED' ? 'Kod noto‘g‘ri yoki muddati o‘tgan.' : errText(e), 'err'); }
    finally { setBusy(false); }
  };
  const request = async (kind: 'export' | 'delete') => {
    if (kind === 'delete' && !window.confirm('Ma’lumotlaringizni o‘chirish so‘rovini yuborasizmi?')) return;
    try { const r = await api('/me/data-requests', { method: 'POST', body: { kind } }); toast(r.note); void loadReqs(); }
    catch (e: any) { toast(e.code === 'DATA_REQUEST_ALREADY_OPEN' ? 'Bu turdagi so‘rovingiz allaqachon ko‘rib chiqilmoqda.' : errText(e), 'err'); }
  };
  const ST: Record<string, string> = { requested: 'Qabul qilindi', in_review: 'Ko‘rib chiqilmoqda', done: 'Bajarildi', rejected: 'Rad etildi' };
  return (
    <div className="prof">
      <h1>Telefon raqam va ma’lumotlarim</h1>
      <section className="card">
        <h2>Telefon raqamni almashtirish</h2>
        <p className="muted small">Xavfsizlik uchun kod ham hozirgi, ham yangi raqamingizga yuboriladi.</p>
        {!ch ? (
          <div className="row" style={{ gap: 8 }}>
            <input aria-label="Yangi raqam" inputMode="tel" autoComplete="tel" placeholder="+998 90 123 45 67" value={phone} onChange={(e) => setPhone(e.target.value)} />
            <button className="btn" disabled={busy || phone.length < 9} onClick={start}>Kod olish</button>
          </div>
        ) : (
          <div className="prof-codes">
            <label>Hozirgi raqamga ({ch.current.phone_masked}) kelgan kod<input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={c1} onChange={(e) => setC1(e.target.value.replace(/\D/g, ''))} /></label>
            <label>Yangi raqamga ({ch.new.phone_masked}) kelgan kod<input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={c2} onChange={(e) => setC2(e.target.value.replace(/\D/g, ''))} /></label>
            {ch.current.dev_code && <p className="muted small">DEV: {ch.current.dev_code} / {ch.new.dev_code}</p>}
            <div className="row" style={{ gap: 8 }}><button className="btn" disabled={busy || c1.length !== 6 || c2.length !== 6} onClick={confirm}>Tasdiqlash</button><button className="btn secondary" onClick={() => setCh(null)}>Bekor</button></div>
          </div>
        )}
      </section>
      <section className="card">
        <h2>Ma’lumotlarim</h2>
        <p className="muted small">Nusxasini so‘rashingiz yoki o‘chirishni so‘rashingiz mumkin. Qonun bo‘yicha saqlanishi shart bo‘lgan buyurtma va to‘lov yozuvlari saqlanadi.</p>
        <div className="row" style={{ gap: 8 }}><button className="btn secondary" onClick={() => request('export')}>Nusxasini so‘rash</button><button className="btn secondary danger-t" onClick={() => request('delete')}>O‘chirishni so‘rash</button></div>
        {reqs.length > 0 && <ul className="small">{reqs.map((r) => <li key={r.id}>{r.kind === 'delete' ? 'O‘chirish' : 'Nusxa'} — {ST[r.status]} ({new Date(r.created_at).toLocaleDateString('uz-UZ')}){r.resolution ? `: ${r.resolution}` : ''}</li>)}</ul>}
      </section>
    </div>
  );
}
