'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errText } from '@/lib/errors';

/** Admin → Xodimlar: invite by phone + role (owner shares the link), see who has which role, revoke with a reason. */
const ROLES: [string, string][] = [['operator', 'Operator'], ['warehouse', 'Omborchi'], ['courier', 'Kuryer'], ['finance', 'Moliya'], ['catalog_manager', 'Katalog menejeri'], ['owner', 'Egasi']];
const ROLE_UZ = Object.fromEntries(ROLES);

export function Staff() {
  const [items, setItems] = useState<any[] | null>(null);
  const [err, setErr] = useState<any>(null);
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState('operator');
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => { api('/admin/staff').then((r) => { setItems(r.items); setErr(null); }).catch(setErr); }, []);
  useEffect(load, [load]);
  if (err) return <div className="notice" role="alert">{err.status === 403 ? 'Xodimlarni faqat egasi boshqaradi.' : errText(err)}</div>;
  return (
    <div className="board">
      <section className="card tpl-form">
        <h2>Xodim qo‘shish</h2>
        <p className="muted small">Telefon raqam va rolni tanlang. Havolani xodimga yuboring — u shu raqam bilan SMS kod orqali kirib, taklifni qabul qiladi. Havola 72 soat va faqat bir marta ishlaydi.</p>
        <div className="bulk-row">
          <div><label htmlFor="st-phone">Telefon</label><input id="st-phone" type="tel" inputMode="tel" placeholder="+998 90 123 45 67" value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
          <div><label htmlFor="st-role">Rol</label><select id="st-role" value={role} onChange={(e) => setRole(e.target.value)}>{ROLES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        </div>
        <button className="btn mt8" disabled={phone.replace(/\D/g, '').length < 9} onClick={async () => {
          setMsg(null); setLink(null); setCopied(false);
          try { const r = await api('/admin/staff/invitations', { method: 'POST', body: { phone, role } }); setLink(r.invite_url); setPhone(''); }
          catch (e: any) { setMsg(e.code === 'PHONE_INVALID' ? 'Telefon raqami noto‘g‘ri.' : errText(e)); }
        }}>Taklif havolasini yaratish</button>
        {link && (
          <div className="inc-item">
            <b className="small">Taklif havolasi ({ROLE_UZ[role]}):</b>
            <code className="link-url">{link}</code>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn secondary sm" onClick={async () => { try { await navigator.clipboard.writeText(link); setCopied(true); } catch { /* clipboard blocked */ } }}>{copied ? 'Nusxalandi ✓' : 'Nusxalash'}</button>
              <a className="btn sm tg" href={`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('UzShop jamoasiga taklif — havolani oching va telefon raqamingiz bilan kiring')}`} target="_blank" rel="noopener noreferrer">Telegram’da yuborish</a>
            </div>
          </div>
        )}
        {msg && <div className="small" role="status">{msg}</div>}
      </section>
      <section className="card">
        <h2>Jamoa ({items?.length ?? 0})</h2>
        {items === null ? <p className="muted">Yuklanmoqda…</p> : items.length === 0 ? <p className="muted">Hali xodim yo‘q.</p> : items.map((u) => (
          <div key={u.id} className="inc-item">
            <div className="spread"><b>{u.display_name ?? '—'}</b><span className="small muted">{u.phone_e164}</span></div>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {u.roles.map((r: string) => (
                <span key={r} className="pill">{ROLE_UZ[r] ?? r}
                  <button type="button" className="link-btn small" aria-label={`${ROLE_UZ[r] ?? r} rolini olib tashlash`} onClick={async () => {
                    const reason = prompt(`${u.display_name ?? 'Xodim'}: «${ROLE_UZ[r] ?? r}» roli olib tashlansinmi? Sababini yozing:`);
                    if (!reason) return;
                    try { await api(`/admin/staff/${u.id}/revoke`, { method: 'POST', body: { role: r, reason } }); load(); } catch (e: any) { setMsg(e.code === 'CANNOT_REVOKE_OWN_OWNER_ROLE' ? 'O‘zingizning egasi rolingizni olib tashlay olmaysiz.' : errText(e)); }
                  }}> ×</button>
                </span>
              ))}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
