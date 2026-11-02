'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

export default function Security() {
  const [sessions, setSessions] = useState<any[]>([]);
  const [enroll, setEnroll] = useState<any>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = () => api('/auth/sessions').then((r) => setSessions(r.items)).catch((e) => setMsg(e.code));
  useEffect(() => { void load(); }, []);
  return (
    <>
      <h1>Xavfsizlik</h1>
      {msg && <div className="notice" role="status">{msg}</div>}
      <section className="card">
        <h2>Ikki bosqichli tasdiq (egasi va moliya uchun majburiy)</h2>
        {!enroll && !recovery && <button className="btn" onClick={async () => { try { setEnroll(await api('/auth/mfa/enroll', { method: 'POST' })); } catch (e: any) { setMsg(e.code); } }}>Autentifikatorni ulash</button>}
        {enroll && !recovery && (
          <>
            <p>Google Authenticator / Aegis kabi ilovaga ushbu kalitni qo‘shing:</p>
            <p><code style={{ wordBreak: 'break-all' }}>{enroll.secret}</code></p>
            <p className="muted" style={{ wordBreak: 'break-all' }}>{enroll.otpauth_uri}</p>
            <label htmlFor="c">Ilovadagi kod</label>
            <input id="c" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
            <button className="btn" style={{ marginTop: 8 }} onClick={async () => { try { const r = await api('/auth/mfa/activate', { method: 'POST', body: { code } }); setRecovery(r.recovery_codes); setEnroll(null); } catch (e: any) { setMsg(e.code); } }}>Faollashtirish</button>
          </>
        )}
        {recovery && (
          <div className="notice">
            <strong>Tiklash kodlari — faqat hozir ko‘rsatiladi. Xavfsiz joyga saqlang:</strong>
            <ul>{recovery.map((r) => <li key={r}><code>{r}</code></li>)}</ul>
          </div>
        )}
      </section>
      <section className="card" style={{ marginTop: 12 }}>
        <h2>Faol sessiyalar</h2>
        <table><tbody>{sessions.map((s) => (
          <tr key={s.id}><td>{s.user_agent?.slice(0, 60) ?? '—'}</td><td>{new Date(s.last_seen_at).toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent' })}</td>
            <td>{s.current ? 'joriy' : <button className="btn secondary" onClick={async () => { await api(`/auth/sessions/${s.id}`, { method: 'DELETE' }).catch((e) => setMsg(e.code)); void load(); }}>Tugatish</button>}</td></tr>
        ))}</tbody></table>
      </section>
    </>
  );
}
