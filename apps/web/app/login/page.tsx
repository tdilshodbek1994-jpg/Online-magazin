'use client';
import { useState } from 'react';
import { api, setToken } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

export default function Login() {
  const { t } = useI18n();
  const [phone, setPhone] = useState('');
  const [ch, setCh] = useState<any>(null);
  const [code, setCode] = useState('');
  const [err, setErr] = useState<any>(null);
  return (
    <div className="card" style={{ maxWidth: 420 }}>
      <h1>{t('login')}</h1>
      {err && <div role="alert" className="notice">{err.code}{err.details?.retry_after_seconds ? ` (${err.details.retry_after_seconds}s)` : ''}</div>}
      <label htmlFor="ph">{t('phone')}</label>
      <input id="ph" type="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+998 90 123 45 67" />
      <button className="btn" style={{ marginTop: 12 }} onClick={async () => { setErr(null); try { setCh(await api('/auth/otp/request', { method: 'POST', body: { phone } })); } catch (e) { setErr(e); } }}>{t('sendCode')}</button>
      {ch && (
        <>
          <p className="muted">{ch.phone_masked}</p>
          {ch.dev_code && <p className="badge test">DEV: {ch.dev_code}</p>}
          <label htmlFor="otp">{t('code')}</label>
          <input id="otp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
          <button className="btn" style={{ marginTop: 12 }} onClick={async () => { setErr(null); try { const r = await api('/auth/otp/verify', { method: 'POST', body: { challenge_id: ch.challenge_id, code } }); setToken(r.token); location.href = '/account'; } catch (e) { setErr(e); } }}>{t('verify')}</button>
        </>
      )}
    </div>
  );
}
