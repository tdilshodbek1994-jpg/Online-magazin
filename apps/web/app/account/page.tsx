'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Async } from '@/components/Header';
import { IconCart } from '@/components/Icons';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';
import { orderStage, uzDate } from '@/lib/orderStatus';
import { InstallRow } from '@/components/InstallApp';

/** "Buyurtmalarim": one card per order with a plain status, the first item and the total — no technical codes. */
export default function Account() {
  const { t, lang } = useI18n();
  const [items, setItems] = useState<any[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [st, setSt] = useState<{ loading: boolean; error: any }>({ loading: true, error: null });
  const load = () => api('/me/orders').then((r) => { setItems(r.items); setSt({ loading: false, error: null }); }).catch((e) => setSt({ loading: false, error: e }));
  useEffect(() => { void load(); api('/me').then((m) => setRoles(m.roles.map((r: any) => r.role))).catch(() => {}); }, []);
  const active = items.filter((o) => { const s = orderStage(o); return s.cls !== 'off' && s.step < 4; });
  return (
    <div className="acc">
      <h1>{t('myOrders')}</h1>
      <Async loading={st.loading} error={st.error} onRetry={load}>
        {items.length === 0 ? (
          <div className="empty"><IconCart size={48} /><p>Hali buyurtma bermagansiz.</p><Link className="btn" href="/catalog">{t('shopNow')}</Link></div>
        ) : (
          <>
            {active.length > 0 && <p className="muted small">{active.length} ta buyurtma yo‘lda yoki tayyorlanmoqda</p>}
            <div className="acc-list">
              {items.map((o) => {
                const s = orderStage(o);
                const name = o.first_name ? pick(o.first_name, lang) : o.number;
                return (
                  <Link key={o.id} href={`/orders/${o.id}`} className="acc-order">
                    {o.image ? <img src={o.image} alt="" width={56} height={56} /> : <span className="ph" aria-hidden />}
                    <span className="acc-info">
                      <b>{name}{o.units > 1 ? <span className="muted"> va yana {o.units - 1} ta</span> : null}</b>
                      <small className="muted">{o.number} · {uzDate(o.created_at)}</small>
                    </span>
                    <span className="acc-right"><b>{som(o.payable_minor)}</b><span className={`wal-st st-${s.cls}`}>{s.label}</span></span>
                  </Link>
                );
              })}
            </div>
          </>
        )}
      </Async>
      <section className="acc-links">
        <InstallRow />
        <Link href="/favorites">❤️ Sevimlilar</Link>
        <Link href="/cart">🛒 Savat</Link>
        <Link href="/legal/returns">↩️ Qaytarish shartlari</Link>
        {roles.includes('partner') ? <Link href="/partner">🤝 Hamkor kabineti</Link> : <Link href="/partner">🤝 Hamkor bo‘lib pul ishlash</Link>}
      </section>
    </div>
  );
}
