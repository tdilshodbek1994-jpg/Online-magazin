'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, getToken, setToken } from '@/lib/api';
import { errText } from '@/lib/errors';
import { loadTelegramSdk, markTgApp, startPath, type TgAppName, type TgWebApp } from '@/lib/telegram';

type State =
  | { k: 'loading' }
  | { k: 'outside' }
  | { k: 'link'; firstName: string | null; rejected: boolean; current: { name: string } | null }
  | { k: 'error'; err: unknown };

const TITLE: Record<TgAppName, string> = { partner: 'Hamkor kabineti', operator: 'Operator xonasi' };

/**
 * Mini App entry (/tg/<app>). Linked Telegram → straight into the cabinet. Not linked → the person proves the
 * account once (phone code, or «continue as» when already logged in on this device), then it is linked for good.
 */
export function TgEntry({ app }: { app: TgAppName }) {
  const router = useRouter();
  const [st, setSt] = useState<State>({ k: 'loading' });
  const [w, setW] = useState<TgWebApp | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const [phone, setPhone] = useState('');
  const [ch, setCh] = useState<any>(null);
  const [code, setCode] = useState('');

  const enter = (wa: TgWebApp) => { wa.HapticFeedback?.notificationOccurred('success'); router.replace(startPath(app, wa.initDataUnsafe.start_param)); };

  const start = async () => {
    setSt({ k: 'loading' });
    markTgApp(app);
    const wa = await loadTelegramSdk();
    setW(wa);
    if (!wa) { setSt({ k: 'outside' }); return; }
    try {
      const r = await api('/auth/telegram/webapp', { method: 'POST', body: { app, init_data: wa.initData } });
      if (r.linked) { setToken(r.token); markTgApp(app); enter(wa); return; }
      let current: { name: string } | null = null;
      if (getToken()) {
        const me = await api('/me').catch(() => null);
        if (me) current = { name: me.display_name || `+${String(me.phone_e164).replace(/^\+/, '').replace(/^(\d{3})(\d{2})\d{3}(\d{2})(\d{2})$/, '$1 $2 *** $3 $4')}` };
      }
      setSt({ k: 'link', firstName: r.first_name ?? wa.initDataUnsafe.user?.first_name ?? null, rejected: !!r.link_token_rejected, current });
    } catch (e) { setSt({ k: 'error', err: e }); }
  };
  useEffect(() => { void start(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const linkNow = async () => {
    if (!w) return;
    setBusy(true); setErr(null);
    try {
      await api('/me/telegram/apps/link', { method: 'POST', body: { app, init_data: w.initData } });
      enter(w);
    } catch (e) { setErr(e); w.HapticFeedback?.notificationOccurred('error'); } finally { setBusy(false); }
  };

  if (st.k === 'loading') return <div className="tg-entry"><div className="tg-spin" aria-label="Yuklanmoqda" /><p className="muted">UzShop ochilmoqda…</p></div>;

  if (st.k === 'outside') return (
    <div className="tg-entry card">
      <div className="lc-icon" aria-hidden>📱</div>
      <h1>{TITLE[app]} — Telegram ilova</h1>
      <p>Bu sahifa Telegram bot ichida ochiladi. Telegram’da botni oching va «Kabinetni ochish» tugmasini bosing.</p>
      <a className="btn" href={app === 'partner' ? '/partner' : '/ops'}>Saytda davom etish</a>
    </div>
  );

  if (st.k === 'error') return (
    <div className="tg-entry card">
      <div className="lc-icon" aria-hidden>⚠️</div>
      <h1>Ochib bo‘lmadi</h1>
      <p role="alert">{(st.err as any)?.code === 'TG_INIT_EXPIRED' ? 'Ilova uzoq vaqt ochiq turdi. Yopib, botdan qayta oching.' : (st.err as any)?.code === 'TG_APP_NOT_CONFIGURED' ? 'Bot hali serverga ulanmagan. Administratorga ayting.' : errText(st.err)}</p>
      <button type="button" className="btn" onClick={() => void start()}>Qayta urinish</button>
    </div>
  );

  return (
    <div className="tg-entry card">
      <div className="lc-icon" aria-hidden>🤝</div>
      <h1>{st.firstName ? `Assalomu alaykum, ${st.firstName}!` : 'Assalomu alaykum!'}</h1>
      <p>Telegram’ni UzShop {app === 'partner' ? 'hamkor' : 'xodim'} hisobingizga <b>bir marta</b> ulaymiz. Keyin bot kabinetni o‘zi ochadi — parol va kod so‘ramaydi.</p>
      {st.rejected && <div className="notice" role="status">Havola eskirgan yoki allaqachon ishlatilgan. Pastdagi usul bilan ulang yoki saytdan yangi havola oling.</div>}
      {err && <div role="alert" className="notice">{err.status === 401 && !err.code
        ? 'Bu sinov serverida birinchi ulash faqat sayt orqali: uzshop saytida Hamkor kabineti → Bildirishnomalar → «Telegram ilovada ochish».'
        : errText(err)}{err.details?.retry_after_seconds ? ` (${err.details.retry_after_seconds} soniyadan keyin)` : ''}</div>}

      {st.current && (
        <div className="tg-current">
          <p className="muted small">Bu qurilmada kirgan hisob:</p>
          <button type="button" className="btn big" disabled={busy} onClick={() => void linkNow()}>{st.current.name} sifatida davom etish</button>
          <p className="muted small">Boshqa raqam bo‘lsa — pastda telefon raqamini kiriting.</p>
        </div>
      )}

      <div className="tg-otp">
        <label htmlFor="tg-ph">Telefon raqamingiz (hamkor sifatida ro‘yxatdan o‘tgan)</label>
        <input id="tg-ph" type="tel" autoComplete="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+998 90 123 45 67" disabled={!!ch} />
        {!ch ? (
          <button type="button" className="btn" disabled={busy || phone.replace(/\D/g, '').length < 9} onClick={async () => {
            setBusy(true); setErr(null);
            try { setCh(await api('/auth/otp/request', { method: 'POST', body: { phone } })); } catch (e) { setErr(e); } finally { setBusy(false); }
          }}>Kod yuborish</button>
        ) : (
          <>
            <p className="muted small">Kod {ch.phone_masked} raqamiga yuborildi. <button type="button" className="linklike" onClick={() => { setCh(null); setCode(''); }}>Raqamni o‘zgartirish</button></p>
            {ch.dev_code && <p className="badge test">SINOV KODI: {ch.dev_code}</p>}
            <label htmlFor="tg-otp">6 xonali kod</label>
            <input id="tg-otp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
            <button type="button" className="btn big" disabled={busy || code.length !== 6} onClick={async () => {
              setBusy(true); setErr(null);
              try {
                const r = await api('/auth/otp/verify', { method: 'POST', body: { challenge_id: ch.challenge_id, code } });
                setToken(r.token); markTgApp(app);
                await linkNow();
              } catch (e) { setErr(e); setBusy(false); }
            }}>Tasdiqlash va ulash</button>
          </>
        )}
      </div>
      <p className="muted small">Yoki saytda: Hamkor kabineti → Bildirishnomalar → «Telegram ilovada ochish».</p>
    </div>
  );
}
