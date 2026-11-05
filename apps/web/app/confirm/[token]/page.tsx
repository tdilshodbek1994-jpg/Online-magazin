'use client';
import { use, useEffect, useState } from 'react';
import { Async } from '@/components/Header';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';

export default function Confirm({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const { t, lang } = useI18n();
  const [d, setD] = useState<any>(null);
  const [st, setSt] = useState<{ loading: boolean; error: any }>({ loading: true, error: null });
  const [code, setCode] = useState('');
  const [result, setResult] = useState<string | null>(null);
  useEffect(() => { api(`/confirm/${token}`).then((r) => { setD(r); setSt({ loading: false, error: null }); }).catch((e) => setSt({ loading: false, error: e })); }, [token]);
  const send = async (decision: 'confirm' | 'reject') => { try { await api(`/confirm/${token}`, { method: 'POST', body: { decision, code } }); setResult(decision); } catch (e) { setSt({ loading: false, error: e }); } };
  if (result) return <div className="notice ok" role="status">{result === 'confirm' ? t('verified') : '✓'}</div>;
  return (
    <Async loading={st.loading} error={st.error}>
      {d && (
        <div className="card" style={{ maxWidth: 560 }}>
          <h1>{t('confirmTitle')}</h1>
          <p><strong>{d.shop_name}</strong> · {d.order.number}</p>
          {d.lines.map((l: any, i: number) => <div key={i} className="spread"><span>{pick(l.product_snapshot.name, lang)} × {l.qty}</span><span>{som(l.line_net_minor)}</span></div>)}
          <div className="spread"><span>{t('delivery')}</span><span>{som(d.order.delivery_minor)}</span></div>
          <div className="spread" style={{ fontWeight: 700 }}><span>{t('total')}</span><span>{som(d.order.payable_minor)}</span></div>
          <p className="muted">{t('payment')}: {t('cod')}. Hech qachon karta ma’lumoti yoki bank SMS kodini hech kimga bermang.</p>
          <label htmlFor="c">{t('code')}</label>
          <input id="c" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn" disabled={code.length !== 6} onClick={() => send('confirm')}>{t('confirm')}</button>
            <button className="btn danger" disabled={code.length !== 6} onClick={() => send('reject')}>{t('reject')}</button>
          </div>
        </div>
      )}
    </Async>
  );
}
