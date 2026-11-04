'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, som } from '@/lib/api';
import { errText } from '@/lib/errors';
import { pick, useI18n } from '@/lib/i18n';

/**
 * Operator Centre 3.0 — "Mening ishim" (spec §05, §11, §12). First screen: shift state, the work that needs me now,
 * callbacks whose time came, and one big "Keyingi ishni olish". A task card always answers five questions and offers
 * only the actions that fit its state. A tel: tap only opens the phone app — the operator records what really happened.
 */
const SHIFT: [string, string][] = [['working', '🟢 Ishdaman'], ['break', '☕ Tanaffus'], ['busy', '⏳ Band'], ['off', '⏹ Smena tugadi']];
const STATE_UZ: Record<string, string> = { queued: 'Navbatda', assigned: 'Menda', in_progress: 'Ishlanmoqda', scheduled: 'Qayta qo‘ng‘iroq', waiting_customer: 'Mijozni kutyapmiz', waiting_internal: 'Ichki muammo', blocked: 'To‘xtagan', resolved: 'Hal qilindi', closed: 'Yopildi' };
const EVENT_UZ: Record<string, string> = { claimed: 'Ishni oldi', reclaimed_after_lease: 'Ishni qayta oldi (oldingi egasi javob bermadi)', released: 'Navbatga qaytardi', contact: 'Aloqa natijasi', auto_closed: 'Avtomatik yopildi' };
const OUT_UZ: Record<string, string> = { no_answer: 'Javob bermadi', busy: 'Band', wrong_number: 'Noto‘g‘ri raqam', callback_requested: 'Keyin qo‘ng‘iroq qilishni so‘radi', info_given: 'Ma’lumot berildi', confirmed: 'Tasdiqladi', rejected: 'Rad etdi', problem: 'Muammo' };
const tash = (v: string) => new Date(v).toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export function WorkDesk({ onChanged }: { onChanged?: () => void }) {
  const { lang } = useI18n();
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [task, setTask] = useState<any>(null);
  const [order, setOrder] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);
  const load = useCallback(async () => { try { setD(await api('/ops/center')); } catch (e: any) { if (e.status === 403) setDenied(true); else setErr(errText(e)); } }, []);
  useEffect(() => { void load(); const i = setInterval(load, 60_000); return () => clearInterval(i); }, [load]);
  const openTask = useCallback(async (id: string) => {
    setErr(null);
    try { const t = await api(`/ops/center/tasks/${id}`); setTask(t); setOrder(await api(`/ops/orders/${t.order_id}`)); } catch (e: any) { setErr(errText(e)); }
  }, []);
  // Keep my lease alive while the card is open (heartbeat), so nobody takes the task mid-call.
  useEffect(() => {
    if (!task?.mine) return;
    const i = setInterval(() => { api(`/ops/center/tasks/${task.id}/heartbeat`, { method: 'POST' }).catch(() => setErr('Bu ish endi sizda emas — yangilang.')); }, 5 * 60_000);
    return () => clearInterval(i);
  }, [task?.id, task?.mine]);
  const run = async (fn: () => Promise<any>, after?: (r: any) => void) => {
    setBusy(true); setErr(null);
    try { const r = await fn(); after?.(r); await load(); onChanged?.(); } catch (e: any) {
      setErr(e.code === 'TASK_VERSION_CONFLICT' || e.code === 'TASK_ALREADY_CLAIMED' ? 'Bu ishni boshqa operator oldi yoki u o‘zgardi — ro‘yxat yangilandi.' : e.code === 'SHIFT_NOT_WORKING' ? 'Yangi ish olish uchun avval «Ishdaman» holatini yoqing.' : e.code === 'WORKLOAD_LIMIT' ? `Sizda ${e.details?.max ?? ''} ta faol ish bor — avval ularni tugating.` : e.code === 'NEXT_CONTACT_REQUIRED' ? 'Qayta qo‘ng‘iroq vaqtini kiriting.' : e.code === 'REASON_REQUIRED' ? 'Sababini yozing.' : errText(e));
      await load();
    } finally { setBusy(false); }
  };
  if (denied) return null;
  if (!d) return err ? <div className="notice" role="alert">{err}</div> : null;
  const c = d.counts;
  return (
    <section className="desk" aria-labelledby="desk-h">
      <div className="desk-top">
        <h2 id="desk-h">Mening ishim</h2>
        <div className="seg desk-shift" role="radiogroup" aria-label="Smena holati">
          {SHIFT.map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={d.shift === k} className={d.shift === k ? 'on' : ''} onClick={() => run(() => api('/ops/center/shift', { method: 'PUT', body: { state: k } }))}>{l}</button>)}
        </div>
      </div>
      <div className="desk-stats">
        <span><b>{d.mine.length}</b> menda</span>
        {c.callbacks_due > 0 && <span className="warn"><b>{c.callbacks_due}</b> qo‘ng‘iroq vaqti keldi</span>}
        {c.overdue > 0 && <span className="bad"><b>{c.overdue}</b> kechikkan</span>}
        <span><b>{c.available}</b> navbatda</span>
        {c.blocked > 0 && <span><b>{c.blocked}</b> to‘xtagan</span>}
      </div>
      <button className="btn big full" disabled={busy || d.shift !== 'working'} onClick={() => run(() => api('/ops/center/next', { method: 'POST' }), (r) => { if (r.task) void openTask(r.task.id); else setErr('Hozircha olinadigan ish yo‘q ✓'); })}>
        ▶ Keyingi ishni olish
      </button>
      {d.shift !== 'working' && <p className="muted small">Yangi ish olish uchun «Ishdaman»ni bosing. Tanaffusda ham boshlagan ishlaringiz sizda qoladi.</p>}
      {err && <div className="notice" role="status">{err}</div>}
      {d.mine.length > 0 && (
        <div className="desk-list">
          {d.mine.map((t: any) => (
            <button key={t.id} type="button" className={`desk-item ${task?.id === t.id ? 'sel' : ''}`} onClick={() => openTask(t.id)}>
              <span className="spread"><b>{t.number}</b><span className={`pill ${t.state === 'scheduled' ? 'b-accepted' : t.state === 'blocked' ? 'b-returned' : 'b-new'}`}>{STATE_UZ[t.state] ?? t.state}{t.not_before ? ` · ${tash(t.not_before)}` : ''}</span></span>
              <span className="small">{t.customer_name ?? '—'} · {t.items_text}</span>
              <span className="small desk-next">➜ {t.next_action}</span>
            </button>
          ))}
        </div>
      )}
      {task && <TaskCard task={task} order={order} lang={lang} busy={busy} onClose={() => { setTask(null); setOrder(null); }}
        onAct={(path, body, done) => run(() => api(`/ops/center/tasks/${task.id}/${path}`, { method: 'POST', body: { expected_version: task.version, ...body } }), () => { if (done) { setTask(null); setOrder(null); } else void openTask(task.id); })} />}
    </section>
  );
}

function TaskCard({ task, order, lang, busy, onClose, onAct }: { task: any; order: any; lang: any; busy: boolean; onClose: () => void; onAct: (path: string, body: any, done: boolean) => void }) {
  const [when, setWhen] = useState('');
  const [note, setNote] = useState('');
  const [readBack, setReadBack] = useState(false);
  const f = task.five;
  const nextAt = when ? new Date(`${when}:00+05:00`).toISOString() : undefined; // the input is Tashkent local time
  const canWrite = task.mine && ['assigned', 'in_progress'].includes(task.state);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <section className="sheet task-sheet" role="dialog" aria-modal="true" aria-label={`Ish ${task.number}`} onClick={(e) => e.stopPropagation()}>
        <div className="spread"><h3>{task.number} · {STATE_UZ[task.state] ?? task.state}</h3><button className="btn secondary sm" onClick={onClose}>Yopish</button></div>
        <dl className="five">
          <div><dt>Nima bo‘ldi?</dt><dd>{f.what}</dd></div>
          <div><dt>Nima yetishmayapti?</dt><dd>{f.missing ?? '—'}</dd></div>
          <div><dt>Kim mas’ul?</dt><dd>{f.who}</dd></div>
          <div><dt>Keyin nima qilinadi?</dt><dd><b>{f.next}</b></dd></div>
          <div><dt>Qachon?</dt><dd>{f.when ? `${f.when.kind === 'callback' ? 'Qayta qo‘ng‘iroq' : 'Muddat'}: ${tash(f.when.at)}` : '—'}</dd></div>
        </dl>
        {order && (
          <div className="task-order">
            <div className="spread"><span>{order.contact_snapshot?.name ?? 'Mijoz'}</span><a className="btn sm" href={`tel:${order.customer_phone}`}>📞 Qo‘ng‘iroq</a></div>
            <p className="muted small">Tugma faqat telefonni ochadi — natijani pastda o‘zingiz belgilaysiz.</p>
            {order.partner_name && <p className="small">🤝 Manba: hamkor {order.partner_name} ({order.partner_code}) — siz olganingiz manbani o‘zgartirmaydi.</p>}
            {order.lines?.map((l: any) => <div key={l.id} className="spread small"><span>{pick(l.product_snapshot.name, lang)} × {l.qty - (l.canceled_qty ?? 0)}</span><span>{som(l.line_net_minor)}</span></div>)}
            <div className="spread"><b>Jami (yetkazish bilan)</b><b>{som(order.payable_minor)}</b></div>
            <div className="small muted">{[order.address_snapshot?.district, order.address_snapshot?.street, order.address_snapshot?.house].filter((x: any) => x && x !== '-').join(', ') || 'Manzil hali yo‘q'}</div>
          </div>
        )}
        {!task.mine && task.state !== 'resolved' && task.state !== 'closed' && <button className="btn full" disabled={busy} onClick={() => onAct('claim', {}, false)}>Bu ishni olish</button>}
        {canWrite && (
          <div className="task-actions">
            <label className="s-check readback"><input type="checkbox" checked={readBack} onChange={(e) => setReadBack(e.target.checked)} /><span>Tarkib va <b>{order ? som(order.payable_minor) : ''}</b> summani mijozga o‘qib berdim</span></label>
            <button className="btn big full" disabled={busy || !readBack || !order} onClick={() => onAct('contact', { outcome: 'confirmed', confirmed_total_minor: order.payable_minor, note: note || 'telefonda og‘zaki tasdiqladi' }, true)}>✅ Tasdiqladi</button>
            <div className="task-grid">
              <button className="btn secondary" disabled={busy} onClick={() => onAct('contact', { outcome: 'no_answer', next_contact_at: nextAt, note: note || undefined }, true)}>Javob bermadi</button>
              <button className="btn secondary" disabled={busy} onClick={() => onAct('contact', { outcome: 'busy', next_contact_at: nextAt, note: note || undefined }, true)}>Band</button>
              <button className="btn secondary" disabled={busy} onClick={() => onAct('contact', { outcome: 'info_given', note: note || undefined }, false)}>Ma’lumot berdim</button>
              <button className="btn secondary" disabled={busy || !when} onClick={() => onAct('contact', { outcome: 'callback_requested', next_contact_at: nextAt, note: note || undefined }, true)}>Keyin qo‘ng‘iroq</button>
            </div>
            <label htmlFor="cb-at">Qayta qo‘ng‘iroq vaqti (Toshkent)</label>
            <input id="cb-at" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
            <label htmlFor="t-note">Izoh (ichki — mijoz va hamkorga ko‘rinmaydi)</label>
            <textarea id="t-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
            <details className="task-more">
              <summary>Boshqa natija</summary>
              <div className="task-grid">
                <button className="btn secondary" disabled={busy || !note} onClick={() => onAct('contact', { outcome: 'wrong_number', note }, true)}>Noto‘g‘ri raqam</button>
                <button className="btn secondary" disabled={busy || !note} onClick={() => onAct('contact', { outcome: 'problem', note }, true)}>Muammo bor</button>
                <button className="btn danger" disabled={busy} onClick={() => { if (confirm('Mijoz rad etdimi? Buyurtma bekor qilinadi.')) onAct('contact', { outcome: 'rejected', note: note || undefined }, true); }}>Rad etdi</button>
                <button className="btn secondary" disabled={busy || note.length < 3} onClick={() => onAct('release', { reason: note }, true)}>Navbatga qaytarish</button>
              </div>
              <p className="muted small">«Noto‘g‘ri raqam», «Muammo» va «Navbatga qaytarish» uchun izohga sababini yozing.</p>
            </details>
          </div>
        )}
        <details className="task-hist">
          <summary>Tarix ({task.events.length + task.calls.length})</summary>
          <ul>
            {task.calls.map((c: any, i: number) => <li key={`c${i}`}><span className="muted small">{tash(c.created_at)}</span> 📞 {OUT_UZ[c.outcome] ?? c.outcome} — {c.operator_name}{c.note ? `: ${c.note}` : ''}</li>)}
            {task.events.map((e: any, i: number) => <li key={`e${i}`}><span className="muted small">{tash(e.created_at)}</span> {EVENT_UZ[e.kind] ?? e.kind}{e.actor_name ? ` — ${e.actor_name}` : ''}{e.data?.outcome ? ` (${OUT_UZ[e.data.outcome] ?? e.data.outcome})` : ''}</li>)}
          </ul>
        </details>
      </section>
    </div>
  );
}
