'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errText } from '@/lib/errors';
import { pick, useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';

/** Review items you actually received (one review per item). */
export default function MyReviews() {
  const { lang } = useI18n();
  const [items, setItems] = useState<any[] | null>(null);
  const [form, setForm] = useState<Record<string, { rating: number; body: string }>>({});
  const load = () => api('/me/reviewable').then((r) => setItems(r.items)).catch(() => setItems([]));
  useEffect(() => { void load(); }, []);
  const send = async (id: string) => {
    const f = form[id]; if (!f?.rating) return;
    try { const r = await api('/me/reviews', { method: 'POST', body: { order_line_id: id, rating: f.rating, ...(f.body.trim() ? { body: f.body.trim() } : {}) } }); toast(r.note); void load(); }
    catch (e: any) { toast(e.code === 'REVIEW_HAS_CONTACTS' ? 'Sharhda telefon yoki havola bo‘lmasin.' : errText(e), 'err'); }
  };
  return (
    <div className="prof">
      <h1>Sharh yozish</h1>
      {items === null && <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>}
      {items?.length === 0 && <div className="empty">Sharh yozish mumkin bo‘lgan mahsulot yo‘q. Yetkazilgan har bir mahsulotga bitta sharh yozish mumkin.</div>}
      {items?.map((x) => { const f = form[x.order_line_id] ?? { rating: 0, body: '' }; return (
        <section key={x.order_line_id} className="card">
          <b>{pick(x.name, lang)}</b>
          <div className="rv-pick" role="radiogroup" aria-label="Baho">{[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" role="radio" aria-checked={f.rating === n} className={n <= f.rating ? 'on' : ''} onClick={() => setForm({ ...form, [x.order_line_id]: { ...f, rating: n } })}>★</button>)}</div>
          <textarea rows={2} maxLength={1000} placeholder="Fikringiz (ixtiyoriy)" value={f.body} onChange={(e) => setForm({ ...form, [x.order_line_id]: { ...f, body: e.target.value } })} />
          <button className="btn sm" disabled={!f.rating} onClick={() => send(x.order_line_id)}>Yuborish</button>
        </section>
      ); })}
    </div>
  );
}
