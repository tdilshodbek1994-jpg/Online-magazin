'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errText } from '@/lib/errors';

/** Meta OAuth return page: the server checks that the state belongs to this admin session (single use, 10 min). */
export default function MetaCallback() {
  const [msg, setMsg] = useState('Tekshirilmoqda…');
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const state = q.get('state'), code = q.get('code');
    if (!state || !code) { setMsg(q.get('error_description') ?? 'Ulash bekor qilindi.'); return; }
    api('/admin/meta/oauth/callback', { method: 'POST', body: { state, code } })
      .then((r) => setMsg(r.status === 'connected' ? '✓ Meta ulandi. Endi admin → Target bo‘limida aktivlarni tasdiqlang.' : `Ulanmadi: ${r.reason}`))
      .catch((e) => setMsg(e.code === 'OAUTH_STATE_INVALID' ? 'Havola eskirgan yoki boshqa sessiyaga tegishli — qaytadan ulang.' : errText(e)));
  }, []);
  return <div className="card" style={{ marginTop: 16 }}><p>{msg}</p><a className="btn sm" href="/admin">Admin panelga qaytish</a></div>;
}
