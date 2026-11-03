'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { RequestsList } from '../requests/RequestsList';

const MISSING_LABEL: Record<string, string> = { product: 'mahsulot', customer_name: 'ism', customer_phone: 'telefon', delivery_zone: 'hudud', address: 'manzil' };

/** "Buyurtmalar": real orders with their stage, and unfinished drafts the partner can continue (V2 §08). */
export default function PartnerOrders() {
  const [tab, setTab] = useState<'orders' | 'drafts'>('orders');
  const [drafts, setDrafts] = useState<any[] | null>(null);
  useEffect(() => { try { if (new URLSearchParams(location.search).get('tab') === 'drafts') setTab('drafts'); } catch {} }, []);
  useEffect(() => { api('/partner/drafts').then((r) => setDrafts(r.items)).catch(() => setDrafts([])); }, []);
  return (
    <>
      <div className="spread"><h1>Buyurtmalar</h1><Link href="/partner/new" className="btn sm">+ Buyurtma</Link></div>
      <div className="seg" role="tablist" aria-label="Buyurtmalar bo‘limi">
        <button role="tab" aria-selected={tab === 'orders'} className={tab === 'orders' ? 'on' : ''} onClick={() => setTab('orders')}>Buyurtmalar</button>
        <button role="tab" aria-selected={tab === 'drafts'} className={tab === 'drafts' ? 'on' : ''} onClick={() => setTab('drafts')}>Qoralamalar{drafts?.length ? ` (${drafts.length})` : ''}</button>
      </div>
      {tab === 'orders' ? <RequestsList embedded /> : (
        <div className="slist">
          {drafts === null && <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>}
          {drafts?.length === 0 && <div className="empty">Tugallanmagan qoralama yo‘q. <Link href="/partner/new">Yangi buyurtma kiriting</Link></div>}
          {drafts?.map((d) => (
            <Link key={d.id} href={`/partner/new?draft=${d.id}`} className="scard draft-card">
              <div className="spread">
                <b>{d.product_names || 'Mahsulot tanlanmagan'}</b>
                <span className={`pill ${d.status === 'awaiting_customer' ? 'b-accepted' : 'b-new'}`}>{d.status === 'awaiting_customer' ? 'Mijoz to‘ldirmoqda' : 'Qoralama'}</span>
              </div>
              <div className="small">{d.customer_name || 'Mijoz ismi yo‘q'}{d.contact_time ? ` · 📞 ${d.contact_time}` : ''}</div>
              {d.missing.length > 0 && <div className="small warn-t">Yetishmayapti: {d.missing.map((m: string) => MISSING_LABEL[m] ?? m).join(', ')}</div>}
              <div className="muted small">Oxirgi o‘zgarish: {new Date(d.updated_at).toLocaleString('uz-UZ', { dateStyle: 'short', timeStyle: 'short' })} · Davom ettirish →</div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
