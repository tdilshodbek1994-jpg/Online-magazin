'use client';
import { use, useEffect, useState } from 'react';
import { Async } from '@/components/Header';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';

export default function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t, lang } = useI18n();
  const [o, setO] = useState<any>(null);
  const [st, setSt] = useState<{ loading: boolean; error: any }>({ loading: true, error: null });
  const load = () => api(`/me/orders/${id}`).then((r) => { setO(r); setSt({ loading: false, error: null }); }).catch((e) => setSt({ loading: false, error: e }));
  useEffect(() => { void load(); }, [id]);
  const pay = async (provider: string) => { try { const r = await api(`/orders/${id}/payment-attempts`, { method: 'POST', body: { provider } }); location.href = r.redirect_url; } catch (e) { setSt({ loading: false, error: e }); } };
  return (
    <Async loading={st.loading} error={st.error} onRetry={load}>
      {o && (
        <div className="card">
          <h1>{o.number}</h1>
          {/* Return from the payment page is NOT proof of payment: status comes from server callbacks only (T061). */}
          {typeof window !== 'undefined' && location.search.includes('payment=return') && o.payment_status !== 'paid' && <div className="notice" role="status">To‘lov tekshirilmoqda… <button className="btn secondary" onClick={load}>{t('retry')}</button></div>}
          <p>{t('status')}: {o.commercial_status} · {o.fulfillment_status} · {t('payment')}: {o.payment_status}</p>
          {o.lines.map((l: any) => <div key={l.id} className="spread"><span>{pick(l.product_snapshot.name, lang)} × {l.qty}</span><span>{som(l.line_net_minor)}</span></div>)}
          <div className="spread" style={{ fontWeight: 700 }}><span>{t('total')}</span><span>{som(o.payable_minor)}</span></div>
          {o.payment_method === 'online' && o.commercial_status === 'confirmed' && ['unpaid', 'failed'].includes(o.payment_status) && (
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn" onClick={() => pay('payme')}>Payme <span className="badge test">{t('test')}</span></button>
              <button className="btn" onClick={() => pay('click')}>Click <span className="badge test">{t('test')}</span></button>
              <button className="btn secondary" onClick={() => pay('mock')}>MOCK</button>
            </div>
          )}
          <h2>Timeline</h2>
          <ul>{o.timeline.map((e: any, i: number) => <li key={i}>{new Date(e.created_at).toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent' })} — {e.dimension}: {e.to_status}</li>)}</ul>
        </div>
      )}
    </Async>
  );
}
