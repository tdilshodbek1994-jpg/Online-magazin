'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { TelegramConnect } from '../shared';
import { errText } from '@/lib/errors';

const ICON: Record<string, string> = { 'partner.order_new': '🛒', 'partner.order_delivered': '✅', 'partner.order_cancelled': '❌', 'partner.commission_available': '💰', 'partner.payout_paid': '💳', 'partner.bonus': '🎁', 'partner.contest_prize': '🏆', 'partner.penalty': '⚠️', 'partner.level_up': '🎖️', 'partner.coupon_issued': '🎟️' };

export default function PartnerNotifications() {
  const [items, setItems] = useState<any[] | null>(null);
  const [err, setErr] = useState<any>(null);
  const [shown, setShown] = useState(20);
  useEffect(() => { api('/me/notifications').then((r) => setItems(r.items)).catch(setErr); }, []);
  return (
    <>
      <h1>Bildirishnomalar</h1>
      <TelegramConnect />
      {err && <div className="notice" role="alert">{errText(err)}</div>}
      {items && items.length === 0 && <div className="empty">Hozircha xabar yo‘q. Birinchi buyurtma kelganda shu yerda ko‘rinadi.</div>}
      <div className="slist">
        {items?.slice(0, shown).map((n) => (
          <article key={n.id} className="scard notif">
            <span className="notif-ico" aria-hidden>{ICON[n.kind] ?? '🔔'}</span>
            <div>
              <div style={{ whiteSpace: 'pre-line' }}>{n.text}</div>
              <div className="muted small">🕒 {new Date(n.created_at).toLocaleString('uz-UZ', { dateStyle: 'short', timeStyle: 'short' })}{n.telegram ? ' · Telegram’ga yuborildi' : ''}</div>
            </div>
          </article>
        ))}
      </div>
      {items && items.length > shown && <button className="btn secondary full mt8" onClick={() => setShown(shown + 20)}>Yana ko‘rsatish ({items.length - shown} ta qoldi)</button>}
    </>
  );
}
