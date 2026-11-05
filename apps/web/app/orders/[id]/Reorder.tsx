'use client';
import { useState } from 'react';
import { notifyCart } from '@/components/Header';
import { api } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';

/** "Yana buyurtma berish": puts the same items in the cart at today's prices; tells what could not be added. */
export function Reorder({ lines }: { lines: any[] }) {
  const { lang } = useI18n();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const items = (lines ?? []).filter((l) => l.sku_id && Number(l.qty) - Number(l.canceled_qty ?? 0) > 0);
  if (!items.length) return null;
  return (
    <div className="reorder">
      <button className="btn secondary full" disabled={busy} onClick={async () => {
        setBusy(true); setMsg(null);
        const missed: string[] = [];
        for (const l of items) {
          try { await api('/cart/lines', { method: 'PUT', body: { sku_id: l.sku_id, qty: Number(l.qty) - Number(l.canceled_qty ?? 0) } }); }
          catch { missed.push(pick(l.product_snapshot?.name, lang)); }
        }
        notifyCart();
        if (missed.length === items.length) { setMsg('Bu mahsulotlar hozir sotuvda yo‘q.'); setBusy(false); return; }
        if (missed.length) { setMsg(`Savatga qo‘shildi. Hozir yo‘q: ${missed.join(', ')}`); setBusy(false); setTimeout(() => { location.href = '/cart'; }, 1800); return; }
        location.href = '/cart';
      }}>🔁 Yana buyurtma berish</button>
      <p className="muted small">Narxlar bugungi narx bo‘yicha hisoblanadi.</p>
      {msg && <div className="notice small" role="status">{msg}</div>}
    </div>
  );
}
