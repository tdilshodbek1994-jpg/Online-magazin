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
  const [picked, setPicked] = useState<string[]>([]);
  const [bulkTo, setBulkTo] = useState('');
  const [bulkReason, setBulkReason] = useState('');
  const [preview, setPreview] = useState<any>(null);
  const [incs, setIncs] = useState<any[]>([]);
  const [incTitle, setIncTitle] = useState('');
  const [incKind, setIncKind] = useState('delivery');
  const loadIncs = useCallback(() => { api('/ops/center/incidents').then((r) => setIncs(r.items)).catch(() => {}); }, []);
  useEffect(loadIncs, [loadIncs]);
  const [qual, setQual] = useState<any>(null);
  useEffect(() => { api('/ops/center/quality?days=30').then(setQual).catch(() => {}); }, []);
  const load = useCallback(() => { api('/ops/center/board').then((r) => { setD(r); setErr(null); }).catch(setErr); }, []);
  useEffect(() => { load(); const i = setInterval(load, 60_000); return () => clearInterval(i); }, [load]);
  if (err) return <div className="notice" role="alert">{err.status === 403 ? 'Bu panel faqat rahbar (ishni qayta taqsimlash huquqi bor xodim) uchun.' : errText(err)}</div>;
  if (!d) return <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>;
  const items: any[] = d.items;
  const now = Date.now();
  const groups: [string, string, (t: any) => boolean][] = [
    ['attention', 'Diqqat talab', (t) => t.sla === 'critical' || t.state === 'blocked' || !t.assignee_id || (t.due_at && new Date(t.due_at).getTime() < now && ['queued', 'assigned'].includes(t.state))],
    ['critical', 'Jiddiy kechikkan', (t) => t.sla === 'critical'],
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
  const bulk = async (dry: boolean) => {
    setMsg(null);
    try {
      const r = await api('/ops/center/bulk/assign', { method: 'POST', body: { task_ids: picked, to_user_id: bulkTo === 'queue' ? null : bulkTo, reason: bulkReason, dry_run: dry } });
      if (dry) setPreview(r); else { setPreview(null); setPicked([]); setMsg(`✓ Bajarildi: ${r.summary.moved ?? 0} ta o‘tkazildi${r.summary.skipped ? `, ${r.summary.skipped} ta o‘tkazib yuborildi` : ''}${r.summary.failed ? `, ${r.summary.failed} ta xato` : ''}`); load(); }
    } catch (e: any) { setMsg(errText(e)); }
  };
  return (
    <div className="board">
      <div className="spread"><h1>Rahbar paneli</h1><Link href="/ops" className="btn secondary sm">← Operator xonasi</Link></div>
      <p className="muted small">Hisoblangan vaqt: {new Date(d.computed_at).toLocaleTimeString('uz-UZ', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit' })} · har daqiqada yangilanadi</p>
      {oldest && <p className="notice">Eng uzoq kutgan egasiz ish: <b>{oldest.number}</b> — {age(oldest.age_seconds)}</p>}
      {incs.some((i) => i.status === 'open') && (
        <section className="card inc-box">
          <h2>Ochiq umumiy muammolar</h2>
          {incs.filter((i) => i.status === 'open').map((i) => (
            <div key={i.id} className="inc-item">
              <div className="spread"><b>{i.title}</b><span className="pill b-returned">{i.kind_uz}</span></div>
              <div className="small muted">{i.open_tasks} ta ish kutyapti · {i.author} · {new Date(i.created_at).toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
              <button className="btn secondary sm" onClick={async () => { const resolution = prompt('Muammo qanday hal bo‘ldi?'); if (!resolution) return; try { const r = await api(`/ops/center/incidents/${i.id}/resolve`, { method: 'POST', body: { resolution } }); setMsg(`✓ Yopildi: ${r.returned_to_queue} ta ish navbatga qaytdi — har bir buyurtmani operator yakunlaydi`); load(); loadIncs(); } catch (e: any) { setMsg(errText(e)); } }}>Hal bo‘ldi</button>
            </div>
          ))}
        </section>
      )}
      <section className="card">
        <h2>Operatorlar</h2>
        <div className="board-staff">
          {d.staff.length === 0 && <p className="muted">Operator roli berilgan xodim yo‘q.</p>}
          {d.staff.map((s: any) => <div key={s.id} className="board-op"><b>{s.display_name}</b><span className="small">{SHIFT_UZ[s.shift] ?? s.shift}</span><span className="small">{s.active} ta faol ish</span></div>)}
        </div>
      </section>
      {qual && qual.items.length > 0 && (
        <details className="card q-box">
          <summary><b>Operatorlar sifati ({qual.days} kun)</b></summary>
          <div className="table-wrap"><table className="q-table">
            <thead><tr><th>Operator</th><th>Ishlar</th><th>Tasdiq</th><th>Rad</th><th>1-aloqa (median)</th></tr></thead>
            <tbody>{qual.items.map((r: any) => (
              <tr key={r.id}><td>{r.display_name}{!r.enough_data && <small className="muted"> · ma’lumot kam</small>}</td>
                <td>{r.tasks_contacted}</td><td>{r.confirm_rate_pct === null ? '—' : `${r.confirmed} (${r.confirm_rate_pct}%)`}</td><td>{r.rejected}</td>
                <td>{r.median_first_contact_min === null ? '—' : r.median_first_contact_min < 60 ? `${r.median_first_contact_min} daq` : `${Math.round(r.median_first_contact_min / 60)} soat`}</td></tr>
            ))}</tbody>
          </table></div>
          <p className="muted small">{qual.note} Kamida {qual.min_sample} ta ish bo‘lmaguncha xulosa chiqarmang. Reyting yo‘q — bu faqat suhbat uchun ma’lumot.</p>
        </details>
      )}
      <QaSample />
      <div className="chips" role="tablist" aria-label="Filtr">
        {groups.map(([k, l, fn]) => <button key={k} role="tab" aria-selected={f === k} className={`chip ${f === k ? 'on' : ''}`} onClick={() => setF(k)}>{l} <span className="q-count">{items.filter(fn).length}</span></button>)}
      </div>
      {msg && <div className="notice" role="status">{msg}</div>}
      {picked.length > 0 && (
        <section className="card bulk-bar" aria-label="Ommaviy amal">
          <b>{picked.length} ta ish tanlandi</b>
          <div className="bulk-row">
            <select value={bulkTo} onChange={(e) => { setBulkTo(e.target.value); setPreview(null); }} aria-label="Tanlanganlarni kimga o‘tkazish">
              <option value="">Kimga o‘tkazish…</option>
              {d.staff.map((s: any) => <option key={s.id} value={s.id}>{s.display_name} ({s.active} ta)</option>)}
              <option value="queue">↩ Umumiy navbatga</option>
            </select>
            <input value={bulkReason} onChange={(e) => { setBulkReason(e.target.value); setPreview(null); }} placeholder="Sabab (majburiy)" aria-label="Ommaviy amal sababi" />
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn secondary sm" disabled={!bulkTo || bulkReason.trim().length < 3} onClick={() => bulk(true)}>1. Oldindan ko‘rish</button>
            <button className="btn sm" disabled={!preview || !preview.summary.would_move} onClick={() => bulk(false)}>2. Bajarish ({preview?.summary.would_move ?? 0})</button>
            <button className="link-btn small" onClick={() => { setPicked([]); setPreview(null); }}>Bekor qilish</button>
          </div>
          {preview && <ul className="bulk-prev small">{preview.results.map((r: any) => <li key={r.task_id}>{r.number ?? r.task_id.slice(0, 8)}: {r.result === 'would_move' ? 'o‘tkaziladi' : 'o‘tkazilmaydi'}{r.reason ? ` — ${r.reason}` : ''}</li>)}</ul>}
          <details className="task-more">
            <summary>Umumiy muammoga bog‘lash</summary>
            <div className="bulk-row">
              <input value={incTitle} onChange={(e) => setIncTitle(e.target.value)} placeholder="Masalan: Kuryer xizmati kechikmoqda" aria-label="Muammo nomi" />
              <select value={incKind} onChange={(e) => setIncKind(e.target.value)} aria-label="Muammo turi">
                <option value="delivery">Yetkazish</option><option value="warehouse">Ombor</option><option value="payment">To‘lov</option><option value="provider">Tashqi xizmat</option><option value="other">Boshqa</option>
              </select>
            </div>
            <button className="btn secondary sm mt8" disabled={incTitle.trim().length < 3} onClick={async () => { try { const r = await api('/ops/center/incidents', { method: 'POST', body: { title: incTitle, kind: incKind, task_ids: picked } }); setMsg(`✓ Muammo ochildi, ${r.linked} ta ish bog‘landi`); setPicked([]); setIncTitle(''); load(); loadIncs(); } catch (e: any) { setMsg(errText(e)); } }}>Bog‘lash ({picked.length})</button>
          </details>
          <p className="muted small">Ommaviy amal faqat ishni o‘tkazish uchun. To‘lov, qaytarish va komissiya ommaviy o‘zgartirilmaydi.</p>
        </section>
      )}
      {list.length === 0 ? <div className="empty">Bu bo‘limda ish yo‘q ✓</div> : (
        <div className="slist">
          {list.map((t) => (
            <article key={t.id} className="scard board-task">
              <div className="spread"><label className="s-check"><input type="checkbox" checked={picked.includes(t.id)} onChange={(e) => { setPreview(null); setPicked(e.target.checked ? [...picked, t.id] : picked.filter((x) => x !== t.id)); }} aria-label={`${t.number} ni tanlash`} /><b>{t.number}</b></label><span className={`pill ${t.state === 'blocked' ? 'b-returned' : t.state === 'scheduled' ? 'b-accepted' : 'b-new'}`}>{STATE_UZ[t.state] ?? t.state}</span></div>
              <div className="small">{t.five.what}</div>
              {t.sla === 'critical' && <div className="sla-pill sla-crit">🔥 Muddat 2 soatdan ko‘p o‘tgan</div>}{t.sla === 'late' && <div className="sla-pill sla-late">⚠️ Muddat o‘tgan</div>}
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

const OUT: Record<string, string> = { no_answer: 'javob bermadi', busy: 'band', wrong_number: 'noto‘g‘ri raqam', callback_requested: 'keyin qo‘ng‘iroq', info_given: 'ma’lumot berildi', confirmed: 'tasdiqladi', rejected: 'rad etdi', problem: 'muammo' };
/** Human QA on a random sample of finished work (spec §25); low scores need a reason, nobody rates their own work. */
function QaSample() {
  const [items, setItems] = useState<any[] | null>(null);
  const [form, setForm] = useState<Record<string, any>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const load = () => api('/ops/center/qa/sample?n=5').then((r) => setItems(r.items)).catch(() => setItems([]));
  return (
    <details className="card q-box" onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && !items) void load(); }}>
      <summary><b>Sifat nazorati (tasodifiy 5 ta ish)</b></summary>
      {items && items.length === 0 && <p className="muted small">Ko‘rib chiqiladigan yakunlangan ish yo‘q.</p>}
      {items?.map((t) => {
        const f = form[t.id] ?? { correct_outcome: true, data_complete: true, clear_communication: true, score: 5, note: '' };
        const set = (k: string, v: any) => setForm({ ...form, [t.id]: { ...f, [k]: v } });
        return (
          <div key={t.id} className="inc-item small">
            <div className="spread"><b>{t.number}</b><span>{t.operator_name}</span></div>
            <div>Natijalar: {(t.outcomes ?? '').split(' → ').map((o: string) => OUT[o] ?? o).join(' → ') || '—'}</div>
            {t.notes && <div className="muted">Izoh: {t.notes}</div>}
            <label className="s-check"><input type="checkbox" checked={f.correct_outcome} onChange={(e) => set('correct_outcome', e.target.checked)} /> Natija to‘g‘ri</label>
            <label className="s-check"><input type="checkbox" checked={f.data_complete} onChange={(e) => set('data_complete', e.target.checked)} /> Ma’lumot to‘liq</label>
            <label className="s-check"><input type="checkbox" checked={f.clear_communication} onChange={(e) => set('clear_communication', e.target.checked)} /> Tushunarli muloqot</label>
            <label htmlFor={`qs-${t.id}`}>Baho: {f.score}</label>
            <input id={`qs-${t.id}`} type="range" min={1} max={5} value={f.score} onChange={(e) => set('score', Number(e.target.value))} />
            <input value={f.note} onChange={(e) => set('note', e.target.value)} placeholder={f.score <= 2 ? 'Sabab (2 va undan past baho uchun majburiy)' : 'Izoh (ixtiyoriy)'} aria-label="QA izohi" />
            <button className="btn secondary sm" disabled={f.score <= 2 && f.note.trim().length < 3} onClick={async () => { try { await api(`/ops/center/qa/${t.id}`, { method: 'POST', body: { checks: { correct_outcome: f.correct_outcome, data_complete: f.data_complete, clear_communication: f.clear_communication }, score: f.score, note: f.note || undefined } }); setMsg('✓ Baholandi — operator ko‘radi va e’tiroz yoza oladi'); setItems(items.filter((x) => x.id !== t.id)); } catch (e: any) { setMsg(errText(e)); } }}>Saqlash</button>
          </div>
        );
      })}
      {msg && <div className="small" role="status">{msg}</div>}
      <p className="muted small">Baho avtomatik jarima emas. Operator har bir bahoni ko‘radi va e’tiroz bildira oladi.</p>
    </details>
  );
}
