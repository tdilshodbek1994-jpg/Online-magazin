'use client';
import { use, useEffect, useState } from 'react';
import { api } from '@/lib/api';

const LABEL: Record<string, string> = { received: 'Qabul qilindi', confirmed: 'Tasdiqlandi', packing: 'Yig‘ilmoqda', shipping: 'Yo‘lda', delivered: 'Topshirildi' };

/** Minimal order status by an opaque link: stages only — no address, phone or money. */
export default function StatusLink({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState(false);
  useEffect(() => { api(`/order-status/${token}`).then(setD).catch(() => setErr(true)); }, [token]);
  if (err) return <div className="card"><h1>Havola amal qilmaydi</h1><p className="muted">Muddati o‘tgan yoki bekor qilingan. Holatni ko‘rish uchun hisobingizga kiring.</p><a className="btn" href="/login">Kirish</a></div>;
  if (!d) return <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>;
  return (
    <div className="card">
      <h1>Buyurtma {d.number}</h1>
      <p className="ord-label"><b>{d.stage.label}</b></p>
      {!['cancelled', 'returned', 'failed'].includes(d.stage.key) && (
        <ol className="ord-steps" aria-label="Buyurtma bosqichlari">{d.steps.map((x: any) => <li key={x.key} className={x.done ? 'done' : ''}><span aria-hidden />{LABEL[x.key]}</li>)}</ol>
      )}
      <p className="muted small">{d.units} dona · yangilangan: {new Date(d.updated_at).toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent', dateStyle: 'short', timeStyle: 'short' })}</p>
      <p className="muted small">{d.note}</p>
    </div>
  );
}
