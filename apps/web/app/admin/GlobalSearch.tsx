'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

const ICON: Record<string, string> = { order: '📦', product: '🛍️', partner: '🤝', staff: '👤' };

/** One search box for staff: orders (number / phone digits), products (SKU, barcode, name), partners, staff — within permissions. */
export function GlobalSearch() {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<any[] | null>(null);
  useEffect(() => {
    if (q.trim().length < 2) { setItems(null); return; }
    const t = setTimeout(() => { api(`/admin/search?q=${encodeURIComponent(q.trim())}`).then((r) => setItems(r.items)).catch(() => setItems([])); }, 300);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="gs">
      <input type="search" aria-label="Hammasidan qidirish" placeholder="🔎 Buyurtma, telefon, SKU, hamkor…" value={q} onChange={(e) => setQ(e.target.value)} />
      {items && (
        <div className="gs-pop" role="listbox">
          {items.length === 0 ? <div className="muted small gs-empty">Hech narsa topilmadi</div> : items.map((i, k) => (
            <a key={k} href={i.href} className="gs-item" role="option"><span aria-hidden>{ICON[i.type]}</span><span><b>{i.title}</b><small className="muted">{i.subtitle}</small></span></a>
          ))}
        </div>
      )}
    </div>
  );
}
