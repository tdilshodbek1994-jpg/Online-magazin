'use client';
import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errText } from '@/lib/errors';
import { AdminOrderList } from '../../AdminOrderList';

const PERIODS: [string, string][] = [['today', 'Bugun'], ['yesterday', 'Kecha'], ['week', 'Hafta'], ['month', 'Shu oy'], ['all', 'Hammasi']];
const SHIFT_UZ: Record<string, string> = { working: '🟢 Ishda', break: '☕ Tanaffusda', busy: '⏳ Band', off: '⏹ Smenada emas' };
const ROLE_UZ: Record<string, string> = { owner: 'Egasi', operator: 'Operator', warehouse: 'Ombor', courier: 'Kuryer', finance: 'Moliya', catalog_manager: 'Katalog', partner: 'Hamkor', customer: 'Xaridor', supervisor: 'Rahbar' };
const tm = (t?: string | null) => (t ? new Date(t).toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const hm = (t?: string | null) => (t ? new Date(t).toLocaleTimeString('uz-UZ', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit' }) : '—');

/** Supervisor watch page for one operator: when they came, how many orders, conversion, every order they touched. */
export default function OperatorWatch({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [period, setPeriod] = useState('today');
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  useEffect(() => { setErr(null); api(`/admin/operators/${id}/watch?period=${period}`).then(setD).catch(setErr); }, [id, period]);
  if (err) return <div className="notice" role="alert">{err.status === 403 ? 'Bu sahifa faqat rahbar uchun.' : errText(err)}</div>;
  if (!d) return <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>;
  const s = d.stats; const u = d.user;
  return (
    <div className="watch">
      <Link href="/ops/board" className="see-all">← Rahbar paneli</Link>
      <div className="spread"><div><h1>{u.display_name ?? 'Xodim'}</h1>
        <div className="muted small">{(u.roles ?? []).map((r: string) => ROLE_UZ[r] ?? r).join(', ') || '—'} · {new Date(u.created_at).toLocaleDateString('uz-UZ')} dan beri</div></div>
        <select aria-label="Davr" value={period} onChange={(e) => setPeriod(e.target.value)} className="req-period">{PERIODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
      <p className="small"><b>{SHIFT_UZ[u.shift] ?? u.shift}</b> · holat o‘zgargan: {tm(u.shift_changed_at)}</p>

      <div className="an-mini">
        <div><b>{s.orders ?? 0}</b><span>buyurtma oldi</span></div>
        <div><b className="ok-t">{s.confirmed ?? 0}</b><span>tasdiqladi</span></div>
        <div><b>{s.conversion_pct === null ? '—' : `${s.conversion_pct}%`}</b><span>konversiya</span></div>
        <div><b>{s.delivered ?? 0}</b><span>yetkazildi</span></div>
      </div>
      <p className="small muted">{s.orders ?? 0} ta buyurtmadan {s.confirmed ?? 0} tasini tasdiqlatdi, {s.rejected ?? 0} tasi rad etdi. Jami {s.calls ?? 0} ta qo‘ng‘iroq: javob bermadi {s.no_answer ?? 0}, keyinroq {s.call_later ?? 0}, ma’lumot noto‘g‘ri {s.wrong_data ?? 0}.</p>
      <p className="small">Birinchi qo‘ng‘iroq: <b>{tm(s.first_call)}</b> · oxirgisi: <b>{tm(s.last_call)}</b></p>

      <details className="card pp-more">
        <summary>Kunlar bo‘yicha (14 kun)</summary>
        {d.daily.length === 0 && <p className="muted small">Qo‘ng‘iroq yo‘q.</p>}
        {d.daily.map((r: any) => <div key={r.day} className="spread small w-prod"><span>{r.day.split('-').reverse().join('.')} · ishni boshladi {hm(r.first_call)}</span><span><b>{r.calls}</b> qo‘ng‘iroq · <b className="ok-t">{r.confirmed}</b> tasdiq</span></div>)}
      </details>
      <details className="card pp-more">
        <summary>Smena tarixi (kelgan / ketgan)</summary>
        {d.shifts.length === 0 && <p className="muted small">Smena belgilanmagan.</p>}
        {d.shifts.map((r: any, i: number) => <div key={i} className="spread small w-prod"><span>{tm(r.occurred_at)}</span><b>{SHIFT_UZ[r.state] ?? r.state}</b></div>)}
      </details>

      <h2 className="an-h2">U ishlagan buyurtmalar</h2>
      <AdminOrderList filter={`operator_id=${id}`} period={period} />
    </div>
  );
}
