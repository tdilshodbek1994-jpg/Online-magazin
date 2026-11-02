'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Async } from '@/components/Header';
import { api, som } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

export default function Account() {
  const { t } = useI18n();
  const [items, setItems] = useState<any[]>([]);
  const [st, setSt] = useState<{ loading: boolean; error: any }>({ loading: true, error: null });
  useEffect(() => { api('/me/orders').then((r) => { setItems(r.items); setSt({ loading: false, error: null }); }).catch((e) => setSt({ loading: false, error: e })); }, []);
  return (
    <>
      <h1>{t('myOrders')}</h1>
      <Async loading={st.loading} error={st.error}>
        {items.length === 0 ? <p>{t('empty')}</p> : <div className="table-wrap"><table><thead><tr><th>№</th><th>{t('status')}</th><th>{t('payment')}</th><th>{t('total')}</th></tr></thead><tbody>
          {items.map((o) => <tr key={o.id}><td><Link href={`/orders/${o.id}`}>{o.number}</Link></td><td>{o.commercial_status} / {o.fulfillment_status}</td><td>{o.payment_status}</td><td>{som(o.payable_minor)}</td></tr>)}
        </tbody></table></div>}
      </Async>
    </>
  );
}
