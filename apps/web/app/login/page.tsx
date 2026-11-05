'use client';
import { useState } from 'react';
import { api, setToken } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { errText } from '@/lib/errors';
import { isNativeApp } from '@/lib/native';

export default function Login() {
  const { t } = useI18n();
  const [phone, setPhone] = useState('');
  const [ch, setCh] = useState<any>(null);
  const [code, setCode] = useState('');
  const [err, setErr] = useState<any>(null);
  return (
    <div className="card" style={{ maxWidth: 420 }}>
      <h1>{t('login')}</h1>
      {err && <div role="alert" className="notice">{errText(err)}{err.details?.retry_after_seconds ? ` (${err.details.retry_after_seconds} soniyadan keyin)` : ''}</div>}
      <label htmlFor="ph">{t('phone')}</label>
      <input id="ph" type="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+998 90 123 45 67" />
      <button className="btn" style={{ marginTop: 12 }} onClick={async () => { setErr(null); try { setCh(await api('/auth/otp/request', { method: 'POST', body: { phone } })); } catch (e) { setErr(e); } }}>{t('sendCode')}</button>
      {ch && (
        <>
          <p className="muted">{ch.phone_masked}</p>
          {ch.dev_code && <p className="badge test">DEV: {ch.dev_code}</p>}
          <label htmlFor="otp">{t('code')}</label>
          <input id="otp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
          <button className="btn" style={{ marginTop: 12 }} onClick={async () => { setErr(null); try { const r = await api('/auth/otp/verify', { method: 'POST', body: { challenge_id: ch.challenge_id, code } }); setToken(r.token); const next = new URLSearchParams(location.search).get('next'); location.href = next && /^\/[a-z]/.test(next) ? next : isNativeApp() ? '/app' : '/account'; } catch (e) { setErr(e); } }}>{t('verify')}</button>
        </>
      )}
    </div>
  );
}
