'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';

/** My returns: goods status and money status shown separately. */
export default function MyReturns() {
  const { lang } = useI18n();
  const [items, setItems] = useState<any[] | null>(null);
  useEffect(() => { api('/me/returns').then((r) => setItems(r.items)).catch(() => setItems([])); }, []);
  return (
    <div className="prof">
      <h1>Qaytarishlarim</h1>
      {items === null && <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>}
      {items?.length === 0 && <div className="empty">Qaytarish so‘rovi yo‘q. Yetkazilgan buyurtma sahifasidan «Qaytarish» tugmasini bosing.</div>}
      {items?.map((r) => (
        <Link key={r.id} href={`/orders/${r.order_id}`} className="card ret-card">
          <div className="oc-top"><b className="ocard-items">{(r.lines ?? []).map((l: any) => `${pick(l.name, lang)} × ${l.qty}`).join(', ')}</b></div>
          <div className="small"><b>Tovar:</b> {r.status_label}</div>
          {r.refund_label && <div className="small"><b>Pul:</b> {r.refund_label}</div>}
          {r.decision_note && <div className="small muted">Izoh: {r.decision_note}</div>}
          <div className="small muted">{r.number} · {new Date(r.created_at).toLocaleDateString('uz-UZ')}</div>
        </Link>
      ))}
    </div>
  );
}
