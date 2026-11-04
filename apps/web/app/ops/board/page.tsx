'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errText } from '@/lib/errors';

/**
 * Operator Centre — supervisor board (spec §24): where work stopped, who owns it, what is needed. Every counter is a
 * filter on the list below; each row offers the one supervisor action that makes sense (transfer with a reason).
 */
const STATE_UZ: Record<string, string> = { queued: 'Navbatda', assigned: 'Olingan', in_progress: 'Ishlanmoqda', scheduled: 'Qayta qo‘ng‘iroq', waiting_customer: 'Mijozni kutyapmiz', waiting_internal: 'Ichki muammo', blocked: 'To‘xtagan' };
const SHIFT_UZ: Record<string, string> = { working: '🟢 Ishda', break: '☕ Tanaffus', busy: '⏳ Band', off: '⏹ Smenada emas' };
const age = (sec: number) => (sec < 3600 ? `${Math.round(sec / 60)} daq` : sec < 86400 ? `${Math.round(sec / 3600)} soat` : `${Math.round(sec / 86400)} kun`);

export default function OpsBoard() {
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const [f, setF] = useState<string>('attention');
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => { api('/ops/center/board').then((r) => { setD(r); setErr(null); }).catch(setErr); }, []);
  useEffect(() => { load(); const i = setInterval(load, 60_000); return () => clearInterval(i); }, [load]);
  if (err) return <div className="notice" role="alert">{err.status === 403 ? 'Bu panel faqat rahbar (ishni qayta taqsimlash huquqi bor xodim) uchun.' : errText(err)}</div>;
  if (!d) return <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>;
  const items: any[] = d.items;
  const now = Date.now();
  const groups: [string, string, (t: any) => boolean][] = [
    ['attention', 'Diqqat talab', (t) => t.state === 'blocked' || !t.assignee_id || (t.due_at && new Date(t.due_at).getTime() < now && ['queued', 'assigned'].includes(t.state))],
    ['blocked', 'To‘xtagan', (t) => t.state === 'blocked'],
    ['unowned', 'Egasiz', (t) => !t.assignee_id],
    ['overdue', 'Kechikkan', (t) => t.due_at && new Date(t.due_at).getTime() < now && ['queued', 'assigned', 'in_progress'].includes(t.state)],
    ['scheduled', 'Qayta qo‘ng‘iroq', (t) => t.state === 'scheduled'],
    ['all', 'Barcha ochiq', () => true],
  ];
  const cur = groups.find((g) => g[0] === f)!;
  const list = items.filter(cur[2]).slice(0, 100);
  const oldest = items.filter((t) => !t.assignee_id).sort((a, b) => b.age_seconds - a.age_seconds)[0];
  const transfer = async (taskId: string, to: string | null) => {
    const reason = prompt(to ? 'Nega bu operatorga o‘tkazilyapti?' : 'Nega navbatga qaytarilyapti?');
    if (!reason) return;
    setMsg(null);
    try { await api(`/ops/center/tasks/${taskId}/assign`, { method: 'POST', body: { to_user_id: to, reason } }); setMsg('✓ O‘tkazildi'); load(); } catch (e: any) { setMsg(errText(e)); }
  };
  return (
    <div className="board">
      <div className="spread"><h1>Rahbar paneli</h1><Link href="/ops" className="btn secondary sm">← Operator xonasi</Link></div>
      <p className="muted small">Hisoblangan vaqt: {new Date(d.computed_at).toLocaleTimeString('uz-UZ', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit' })} · har daqiqada yangilanadi</p>
      {oldest && <p className="notice">Eng uzoq kutgan egasiz ish: <b>{oldest.number}</b> — {age(oldest.age_seconds)}</p>}
      <section className="card">
        <h2>Operatorlar</h2>
        <div className="board-staff">
          {d.staff.length === 0 && <p className="muted">Operator roli berilgan xodim yo‘q.</p>}
          {d.staff.map((s: any) => <div key={s.id} className="board-op"><b>{s.display_name}</b><span className="small">{SHIFT_UZ[s.shift] ?? s.shift}</span><span className="small">{s.active} ta faol ish</span></div>)}
        </div>
      </section>
      <div className="chips" role="tablist" aria-label="Filtr">
        {groups.map(([k, l, fn]) => <button key={k} role="tab" aria-selected={f === k} className={`chip ${f === k ? 'on' : ''}`} onClick={() => setF(k)}>{l} <span className="q-count">{items.filter(fn).length}</span></button>)}
      </div>
      {msg && <div className="notice" role="status">{msg}</div>}
      {list.length === 0 ? <div className="empty">Bu bo‘limda ish yo‘q ✓</div> : (
        <div className="slist">
          {list.map((t) => (
            <article key={t.id} className="scard board-task">
              <div className="spread"><b>{t.number}</b><span className={`pill ${t.state === 'blocked' ? 'b-returned' : t.state === 'scheduled' ? 'b-accepted' : 'b-new'}`}>{STATE_UZ[t.state] ?? t.state}</span></div>
              <div className="small">{t.five.what}</div>
              {t.blocked_by && <div className="small warn-t">⛔ {t.blocked_by}</div>}
              <div className="small"><b>Keyingi qadam:</b> {t.next_action}</div>
              <div className="small muted">👤 {t.assignee_name ?? 'egasiz'} · ⏱ {age(t.age_seconds)}{t.attempts ? ` · ${t.attempts} urinish` : ''}{t.not_before ? ` · 📞 ${new Date(t.not_before).toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : ''}</div>
              <div className="board-act">
                <label className="sr-only" htmlFor={`as-${t.id}`}>Kimga o‘tkazish</label>
                <select id={`as-${t.id}`} defaultValue="" onChange={(e) => { const v = e.target.value; e.target.value = ''; if (v) void transfer(t.id, v === 'queue' ? null : v); }}>
                  <option value="">O‘tkazish…</option>
                  {d.staff.filter((s: any) => s.id !== t.assignee_id).map((s: any) => <option key={s.id} value={s.id}>{s.display_name} ({SHIFT_UZ[s.shift]?.slice(3) ?? s.shift}, {s.active} ta)</option>)}
                  {t.assignee_id && <option value="queue">↩ Umumiy navbatga</option>}
                </select>
                <Link className="see-all" href={`/ops?order=${t.order_id}`}>Buyurtma →</Link>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
