'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errText } from '@/lib/errors';

export default function Security() {
  const [sessions, setSessions] = useState<any[]>([]);
  const [enroll, setEnroll] = useState<any>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = () => api('/auth/sessions').then((r) => setSessions(r.items)).catch((e) => setMsg(errText(e)));
  useEffect(() => { void load(); }, []);
  return (
    <>
      <h1>Xavfsizlik</h1>
      {msg && <div className="notice" role="status">{msg}</div>}
      <section className="card">
        <h2>Ikki bosqichli tasdiq (egasi va moliya uchun majburiy)</h2>
        {!enroll && !recovery && <button className="btn" onClick={async () => { try { setEnroll(await api('/auth/mfa/enroll', { method: 'POST' })); } catch (e: any) { setMsg(errText(e)); } }}>Autentifikatorni ulash</button>}
        {enroll && !recovery && (
          <div className="mfa-steps">
            <p className="notice small">🔒 Bu kalit maxfiy — skrinshot olib hech kimga yubormang.</p>
            <ol>
              <li>Telefonga <b>Google Authenticator</b> ilovasini o‘rnating (Play Market / App Store, bepul).</li>
              <li>
                Shu telefonda bo‘lsangiz, quyidagi tugmani bosing — ilova kalitni o‘zi qo‘shadi:
                <a className="btn sm mt8" href={enroll.otpauth_uri}>📲 Ilovaga qo‘shish</a>
                <span className="muted small">Ochilmasa: ilovada «+» → «Kalitni kiritish», hisob nomi <b>UzShop</b>, kalit:</span>
                <span className="mfa-key">
                  <code>{String(enroll.secret).replace(/(.{4})/g, '$1 ').trim()}</code>
                  <button type="button" className="btn secondary sm" onClick={async () => { try { await navigator.clipboard.writeText(enroll.secret); setMsg('Kalit nusxalandi — ilovaga qo‘ying'); } catch { /* clipboard blocked */ } }}>Nusxalash</button>
                </span>
              </li>
              <li>Ilovada <b>6 xonali kod</b> paydo bo‘ladi (har 30 soniyada yangilanadi). O‘shani shu yerga yozing:</li>
            </ol>
            <label htmlFor="c">Ilovadagi 6 xonali kod</label>
            <input id="c" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
            <button className="btn" style={{ marginTop: 8 }} disabled={code.length !== 6} onClick={async () => { try { const r = await api('/auth/mfa/activate', { method: 'POST', body: { code } }); setRecovery(r.recovery_codes); setEnroll(null); } catch (e: any) { setMsg(e.code === 'MFA_CODE_INVALID' ? 'Kod noto‘g‘ri. Ilovadagi eng yangi kodni yozing (telefon soati to‘g‘ri bo‘lishi kerak).' : errText(e)); } }}>Faollashtirish</button>
            <button type="button" className="link-btn small" onClick={async () => { try { setEnroll(await api('/auth/mfa/enroll', { method: 'POST' })); setCode(''); setMsg('Yangi kalit yaratildi — eskisini ilovadan o‘chiring.'); } catch (e: any) { setMsg(errText(e)); } }}>Yangi kalit olish</button>
          </div>
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
        <div className="table-wrap"><table><tbody>{sessions.map((s) => (
          <tr key={s.id}><td>{s.user_agent?.slice(0, 60) ?? '—'}</td><td>{new Date(s.last_seen_at).toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent' })}</td>
            <td>{s.current ? 'joriy' : <button className="btn secondary" onClick={async () => { await api(`/auth/sessions/${s.id}`, { method: 'DELETE' }).catch((e) => setMsg(errText(e))); void load(); }}>Tugatish</button>}</td></tr>
        ))}</tbody></table></div>
      </section>
    </>
  );
}
