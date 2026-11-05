'use client';
import Link from 'next/link';
import { use, useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errText } from '@/lib/errors';
import { toast } from '@/lib/toast';

const ROLE_UZ: Record<string, string> = { owner: 'Egasi', catalog_manager: 'Katalog menejeri', operator: 'Operator', warehouse: 'Omborchi', courier: 'Kuryer', finance: 'Moliya', partner: 'Hamkor' };
const dt = (s: string | null) => (s ? new Date(s).toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent', dateStyle: 'short', timeStyle: 'short' }) : '—');

/** Staff profile: roles with history, security, own recent actions; sign-out everywhere (step-up). */
export default function StaffProfile({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const load = useCallback(() => { api(`/admin/staff/${id}`).then(setD).catch(setErr); }, [id]);
  useEffect(load, [load]);
  const revokeRole = async (role: string) => {
    const reason = prompt(`«${ROLE_UZ[role] ?? role}» roli olib tashlansinmi? Sababini yozing:`); if (!reason) return;
    try { await api(`/admin/staff/${id}/revoke`, { method: 'POST', body: { role, reason } }); toast('✓ Rol olib tashlandi'); load(); } catch (e: any) { toast(e.code === 'CANNOT_REVOKE_OWN_OWNER_ROLE' ? 'O‘zingizning egasi rolingizni olib tashlay olmaysiz.' : errText(e), 'err'); }
  };
  const signOut = async () => {
    const reason = prompt('Barcha qurilmalardan chiqarilsinmi? Sababini yozing:'); if (!reason) return;
    try { const r = await api(`/admin/staff/${id}/sessions/revoke`, { method: 'POST', body: { reason } }); toast(`✓ ${r.revoked} ta sessiya yopildi`); load(); } catch (e: any) { toast(e.code === 'STEP_UP_REQUIRED' ? 'Avval qayta tasdiqlang (MFA).' : errText(e), 'err'); }
  };
  if (err) return <div className="wrap"><div className="notice" role="alert">{errText(err)}</div><Link href="/admin?tab=staff">← Xodimlar</Link></div>;
  if (!d) return <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>;
  const active = d.roles.filter((r: any) => !r.revoked_at);
  const past = d.roles.filter((r: any) => r.revoked_at);
  return (
    <div className="wrap stp">
      <Link href="/admin?tab=staff" className="small">← Xodimlar</Link>
      <section className="card stp-head">
        <div className="stp-ava" aria-hidden>{(d.display_name ?? '?').slice(0, 2).toUpperCase()}</div>
        <div><h1>{d.display_name ?? '—'}</h1><div className="muted">{d.phone_e164}</div><div className="small muted">Qo‘shilgan: {dt(d.created_at)}{d.status !== 'active' ? ` · holati: ${d.status}` : ''}</div></div>
      </section>
      <section className="card">
        <h2>Rollari</h2>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>{active.map((r: any) => (
          <span key={r.role_code} className="pill">{ROLE_UZ[r.role_code] ?? r.role_code}{r.role_code !== 'partner' && <button className="link-btn small" aria-label="Rolni olib tashlash" onClick={() => revokeRole(r.role_code)}> ×</button>}</span>
        ))}</div>
        {past.length > 0 && <details className="small"><summary>Avvalgi rollar ({past.length})</summary>{past.map((r: any, i: number) => <div key={i}>{ROLE_UZ[r.role_code] ?? r.role_code}: {dt(r.created_at)} — {dt(r.revoked_at)}</div>)}</details>}
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {d.links.operator && <Link className="btn secondary sm" href={d.links.operator}>Operator ishini ko‘rish ›</Link>}
          {d.links.partner && <Link className="btn secondary sm" href={d.links.partner}>Hamkor sahifasi ›</Link>}
        </div>
      </section>
      <section className="card">
        <h2>Xavfsizlik</h2>
        <dl className="dec-fig">
          <div><dt>Ikki bosqichli himoya (MFA)</dt><dd>{d.security.mfa ? 'Yoqilgan ✓' : 'Yo‘q'}</dd></div>
          <div><dt>Ochiq sessiyalar</dt><dd>{d.security.sessions}</dd></div>
          <div><dt>Oxirgi faollik</dt><dd>{dt(d.security.last_seen)}</dd></div>
          <div><dt>Amallar: bugun / 7 kun</dt><dd>{d.counts.today} / {d.counts.week}</dd></div>
        </dl>
        {d.security.sessions > 0 && <button className="btn secondary sm danger-t" onClick={signOut}>Barcha qurilmalardan chiqarish</button>}
      </section>
      <section className="card">
        <h2>Oxirgi amallari</h2>
        {d.actions.length === 0 ? <p className="muted small">Hali amal yo‘q.</p> : (
          <ul className="stp-acts">{d.actions.map((a: any, i: number) => <li key={i}><span>{a.label}{a.reason ? <small className="muted"> — {a.reason}</small> : null}</span><small className="muted">{dt(a.occurred_at)}</small></li>)}</ul>
        )}
      </section>
    </div>
  );
}
