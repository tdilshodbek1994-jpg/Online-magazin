'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, getToken } from '@/lib/api';
import { errText } from '@/lib/errors';

/** Staff invitation: the invitee logs in with the invited phone (SMS code), then accepts. The link alone grants nothing. */
const ROLE_UZ: Record<string, [string, string]> = {
  operator: ['Operator', '/ops'], warehouse: ['Omborchi', '/ops'], courier: ['Kuryer', '/courier'], finance: ['Moliya', '/admin'],
  catalog_manager: ['Katalog menejeri', '/admin'], owner: ['Egasi', '/admin'],
};

export default function StaffJoin() {
  const [token, setToken] = useState<string | null>(null);
  const [logged, setLogged] = useState(false);
  const [state, setState] = useState<{ ok?: string; err?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { try { setToken(new URLSearchParams(location.search).get('token')); } catch {} setLogged(!!getToken()); }, []);
  if (!token) return <div className="card fill-card"><h1>Xodim taklifi</h1><p className="notice">Havola noto‘liq. Taklif qilgan odamdan havolani qayta so‘rang.</p></div>;
  const next = `/staff/join?token=${encodeURIComponent(token)}`;
  return (
    <div className="card fill-card">
      <h1>UzShop jamoasiga taklif</h1>
      {state?.ok ? (
        <>
          <p className="notice ok">✓ Siz endi <b>{ROLE_UZ[state.ok]?.[0] ?? state.ok}</b> sifatida ishlaysiz.</p>
          <Link className="btn full" href={ROLE_UZ[state.ok]?.[1] ?? '/'}>Ish joyiga o‘tish</Link>
        </>
      ) : !logged ? (
        <>
          <p>Taklifni qabul qilish uchun <b>sizga taklif yuborilgan telefon raqam</b> bilan kiring. SMS kod faqat shu raqamga keladi.</p>
          <Link className="btn full" href={`/login?next=${encodeURIComponent(next)}`}>Telefon raqam bilan kirish</Link>
        </>
      ) : (
        <>
          <p>Taklifni qabul qilsangiz, hisobingizga xodim roli qo‘shiladi. Taklif 72 soat amal qiladi va faqat bir marta ishlaydi.</p>
          <button className="btn full" disabled={busy} onClick={async () => {
            setBusy(true); setState(null);
            try { const r = await api('/staff/invitations/accept', { method: 'POST', body: { token } }); setState({ ok: r.role }); }
            catch (e: any) { setState({ err: e.code === 'INVITATION_PHONE_MISMATCH' ? 'Bu taklif boshqa telefon raqam uchun. Taklif yuborilgan raqam bilan kiring.' : e.code === 'INVITATION_INVALID_OR_EXPIRED' ? 'Taklif muddati o‘tgan yoki allaqachon ishlatilgan. Yangi taklif so‘rang.' : errText(e) }); }
            finally { setBusy(false); }
          }}>Taklifni qabul qilish</button>
        </>
      )}
      {state?.err && <p className="notice" role="alert">{state.err}</p>}
    </div>
  );
}
