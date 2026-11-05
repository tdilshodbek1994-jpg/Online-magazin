'use client';
import { use, useEffect, useState } from 'react';
import { Async } from '@/components/Header';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';
import { eventLabel, orderStage, PAYMENT_LABEL, STEPS } from '@/lib/orderStatus';
import { Reorder } from './Reorder';
import { SelfActions } from './SelfActions';

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
          {(() => { const sg = orderStage(o); return (
            <div className="ord-stage">
              <div className="spread"><b className="ord-label">{sg.label}</b><span className={`wal-st st-${o.payment_status === 'paid' ? 'ok' : 'wait'}`}>{o.payment_method === 'cod' && o.payment_status === 'unpaid' ? 'Olganda to‘laysiz' : PAYMENT_LABEL[o.payment_status] ?? o.payment_status}</span></div>
              <p className="muted small">{sg.hint}</p>
              {sg.step >= 0 && <ol className="ord-steps" aria-label="Buyurtma bosqichlari">{STEPS.map((x, i) => <li key={x} className={i < sg.step ? 'done' : i === sg.step ? 'now' : ''} aria-current={i === sg.step ? 'step' : undefined}><span aria-hidden />{x}</li>)}</ol>}
            </div>
          ); })()}
          <h2>Mahsulotlar</h2>
          {o.lines.map((l: any) => <div key={l.id} className="ord-line"><span>{pick(l.product_snapshot.name, lang)} × {l.qty}</span><span>{som(l.line_net_minor)}</span></div>)}
          {BigInt(o.discount_minor ?? 0) > 0n && <div className="ord-line"><span>Chegirma</span><span className="save-t">−{som(o.discount_minor)}</span></div>}
          <div className="ord-line"><span>Yetkazish</span><span>{BigInt(o.delivery_minor ?? 0) === 0n ? 'Bepul' : som(o.delivery_minor)}</span></div>
          <div className="ord-line ord-total"><span>{t('total')}</span><span>{som(o.payable_minor)}</span></div>
          {o.payment_method === 'online' && o.commercial_status === 'confirmed' && ['unpaid', 'failed'].includes(o.payment_status) && (
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn" onClick={() => pay('payme')}>Payme <span className="badge test">{t('test')}</span></button>
              <button className="btn" onClick={() => pay('click')}>Click <span className="badge test">{t('test')}</span></button>
              <button className="btn secondary" onClick={() => pay('mock')}>Sinov to‘lovi</button>
            </div>
          )}
          {o.address_snapshot && <p className="small"><b>Manzil:</b> {[o.address_snapshot.district, o.address_snapshot.street, o.address_snapshot.house && `${o.address_snapshot.house}-uy`, o.address_snapshot.apartment && `${o.address_snapshot.apartment}-xonadon`].filter(Boolean).join(', ')}</p>}
          {o.messages?.length > 0 && <div className="ord-msgs"><h2>Do‘kondan xabarlar</h2>{o.messages.map((m: any, i: number) => <div key={i} className="ord-msg"><span>💬 {m.body}</span><small className="muted">{new Date(m.created_at).toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent', dateStyle: 'short', timeStyle: 'short' })}</small></div>)}</div>}
          <SelfActions o={{ ...o, id }} onChanged={load} />
          <Reorder lines={o.lines} />
          <details className="ord-hist">
            <summary>Buyurtma tarixi ({o.timeline.length})</summary>
            <ul>{o.timeline.map((e: any, i: number) => <li key={i}><span className="muted small">{new Date(e.created_at).toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent', dateStyle: 'short', timeStyle: 'short' })}</span> {eventLabel(e.dimension, e.to_status)}</li>)}</ul>
          </details>
          <p className="muted small">Savol bo‘lsa, operator siz ko‘rsatgan raqamga qo‘ng‘iroq qiladi. <a href="/account">← Buyurtmalarim</a></p>
        </div>
      )}
    </Async>
  );
}
