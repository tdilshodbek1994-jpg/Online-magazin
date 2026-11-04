'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, som } from '@/lib/api';
import { errText } from '@/lib/errors';
import { toast } from '@/lib/toast';
import { pick, useI18n } from '@/lib/i18n';

/**
 * Operator Centre 3.0 — "Mening ishim" (spec §05, §11, §12). First screen: shift state, the work that needs me now,
 * callbacks whose time came, and one big "Keyingi ishni olish". A task card always answers five questions and offers
 * only the actions that fit its state. A tel: tap only opens the phone app — the operator records what really happened.
 */
const SHIFT: [string, string][] = [['working', '🟢 Ishdaman'], ['break', '☕ Tanaffus'], ['busy', '⏳ Band'], ['off', '⏹ Smena tugadi']];
const STATE_UZ: Record<string, string> = { queued: 'Navbatda', assigned: 'Menda', in_progress: 'Ishlanmoqda', scheduled: 'Qayta qo‘ng‘iroq', waiting_customer: 'Mijozni kutyapmiz', waiting_internal: 'Ichki muammo', blocked: 'To‘xtagan', resolved: 'Hal qilindi', closed: 'Yopildi' };
const EVENT_UZ: Record<string, string> = { sla_escalated: 'Muddat jiddiy o‘tdi — rahbarga ko‘tarildi', handoff_requested: 'Topshirish so‘raldi', handoff_accepted: 'Topshirish qabul qilindi', handoff_declined: 'Topshirish rad etildi', handoff_expired: 'Topshirish muddati o‘tdi', handoff_cancelled: 'Topshirish bekor qilindi', supervisor_transfer: 'Rahbar o‘tkazdi', partner_request: 'Hamkor so‘rovi', partner_answered: 'Hamkorga javob berildi', claimed: 'Ishni oldi', reclaimed_after_lease: 'Ishni qayta oldi (oldingi egasi javob bermadi)', released: 'Navbatga qaytardi', contact: 'Aloqa natijasi', auto_closed: 'Avtomatik yopildi' };
/** What the operator sees on top after a successful tap. */
function okText(path: string, body: any): string {
  if (path === 'claim') return '✓ Ish sizga olindi';
  if (path === 'release') return '✓ Navbatga qaytarildi';
  if (path === 'handoff') return '✓ Topshirish so‘rovi yuborildi';
  const o = body?.outcome;
  return o === 'confirmed' ? '✅ Tasdiqlandi — buyurtma omborga o‘tdi' : o === 'rejected' ? '✓ Rad etildi — buyurtma bekor qilindi' : o === 'info_given' ? '✓ Ma’lumot berildi deb yozildi' : o ? `✓ Saqlandi: ${OUT_UZ[o] ?? o}` : '✓ Saqlandi';
}
const OUT_UZ: Record<string, string> = { no_answer: 'Javob bermadi', busy: 'Band', wrong_number: 'Noto‘g‘ri raqam', callback_requested: 'Keyin qo‘ng‘iroq qilishni so‘radi', info_given: 'Ma’lumot berildi', confirmed: 'Tasdiqladi', rejected: 'Rad etdi', problem: 'Muammo' };
const SLA_UZ: Record<string, [string, string]> = { soon: ['⏰ Muddat yaqin', 'sla-soon'], late: ['⚠️ Kechikdi', 'sla-late'], critical: ['🔥 Jiddiy kechikdi', 'sla-crit'] };
const tash = (v: string) => new Date(v).toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export function WorkDesk({ onChanged }: { onChanged?: () => void }) {
  const { lang } = useI18n();
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [task, setTask] = useState<any>(null);
  const [order, setOrder] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);
  const [ho, setHo] = useState<{ incoming: any[]; outgoing: any[] }>({ incoming: [], outgoing: [] });
  const load = useCallback(async () => { try { api('/ops/center/handoffs').then(setHo).catch(() => {}); setD(await api('/ops/center')); } catch (e: any) { if (e.status === 403) setDenied(true); else setErr(errText(e)); } }, []);
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
  const run = async (fn: () => Promise<any>, after?: (r: any) => void, okMsg?: string) => {
    setBusy(true); setErr(null);
    try { const r = await fn(); if (okMsg) toast(okMsg); after?.(r); await load(); onChanged?.(); } catch (e: any) {
      const m = (e.code === 'TASK_VERSION_CONFLICT' || e.code === 'TASK_ALREADY_CLAIMED' ? 'Bu ishni boshqa operator oldi yoki u o‘zgardi — ro‘yxat yangilandi.' : e.code === 'SHIFT_NOT_WORKING' ? 'Yangi ish olish uchun avval «Ishdaman» holatini yoqing.' : e.code === 'WORKLOAD_LIMIT' ? `Sizda ${e.details?.max ?? ''} ta faol ish bor — avval ularni tugating.` : e.code === 'NEXT_CONTACT_REQUIRED' ? 'Qayta qo‘ng‘iroq vaqtini kiriting.' : e.code === 'REASON_REQUIRED' ? 'Sababini yozing.' : e.code === 'OUTSIDE_CONTACT_HOURS' ? `Mijozga faqat ${e.details?.from ?? 9}:00–${e.details?.to ?? 21}:00 oralig‘ida qo‘ng‘iroq qilinadi.` : e.code === 'HANDOFF_ALREADY_PENDING' ? 'Bu ish uchun topshirish so‘rovi allaqachon yuborilgan.' : e.code === 'HANDOFF_NOT_PENDING' ? 'Topshirish so‘rovi endi amal qilmaydi.' : errText(e));
      setErr(m); toast(m, 'err');
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
          {SHIFT.map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={d.shift === k} className={d.shift === k ? 'on' : ''} onClick={() => run(() => api('/ops/center/shift', { method: 'PUT', body: { state: k } }), undefined, `✓ Holat: ${l}`)}>{l}</button>)}
        </div>
      </div>
      <div className="desk-stats">
        <span><b>{d.mine.length}</b> menda</span>
        {c.callbacks_due > 0 && <span className="warn"><b>{c.callbacks_due}</b> qo‘ng‘iroq vaqti keldi</span>}
        {c.overdue > 0 && <span className="bad"><b>{c.overdue}</b> kechikkan{c.critical > 0 ? ` (${c.critical} tasi 2 soatdan ko‘p)` : ''}</span>}
        <span><b>{c.available}</b> navbatda</span>
        {c.blocked > 0 && <span><b>{c.blocked}</b> to‘xtagan</span>}
      </div>
      <button className="btn big full" disabled={busy || d.shift !== 'working'} onClick={() => run(() => api('/ops/center/next', { method: 'POST' }), (r) => { if (r.task) void openTask(r.task.id); else setErr('Hozircha olinadigan ish yo‘q ✓'); })}>
        ▶ Keyingi ishni olish
      </button>
      {d.shift !== 'working' && <p className="muted small">Yangi ish olish uchun «Ishdaman»ni bosing. Tanaffusda ham boshlagan ishlaringiz sizda qoladi.</p>}
      {err && <div className="notice" role="status">{err}</div>}
      {ho.incoming.length > 0 && (
        <div className="desk-ho" role="region" aria-label="Sizga topshirilayotgan ishlar">
          <b>Sizga topshirilmoqda ({ho.incoming.length})</b>
          {ho.incoming.map((h: any) => (
            <div key={h.id} className="ho-card">
              <div className="spread"><b>{h.number}</b><span className="muted small">{h.from_name} dan</span></div>
              <dl className="ho-pkg">
                <div><dt>Nima qilindi</dt><dd>{h.package.done}</dd></div>
                {h.package.customer_said && <div><dt>Mijoz nima dedi</dt><dd>{h.package.customer_said}</dd></div>}
                {h.package.promised && <div><dt>Nima va’da qilindi</dt><dd>{h.package.promised}</dd></div>}
                {h.package.missing && <div><dt>Nima yetishmaydi</dt><dd>{h.package.missing}</dd></div>}
                <div><dt>Keyingi qadam</dt><dd><b>{h.package.next}</b></dd></div>
              </dl>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn sm" disabled={busy} onClick={() => run(() => api(`/ops/center/handoffs/${h.id}/accept`, { method: 'POST', body: {} }), (r) => r.task_id && openTask(r.task_id))}>Qabul qilish</button>
                <button className="btn secondary sm" disabled={busy} onClick={() => { const reason = prompt('Nega qabul qilmaysiz?'); if (reason) void run(() => api(`/ops/center/handoffs/${h.id}/decline`, { method: 'POST', body: { reason } })); }}>Rad etish</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {ho.outgoing.length > 0 && <p className="muted small">⏳ {ho.outgoing.map((h: any) => `${h.number} → ${h.to_name}`).join(', ')}: qabul qilinishi kutilmoqda. Qabul qilinguncha ish sizda.</p>}
      {d.mine.length > 0 && (
        <div className="desk-list">
          {d.mine.map((t: any) => (
            <button key={t.id} type="button" className={`desk-item ${task?.id === t.id ? 'sel' : ''}`} onClick={() => openTask(t.id)}>
              <span className="spread"><b>{t.number}</b><span className={`pill ${t.state === 'scheduled' ? 'b-accepted' : t.state === 'blocked' ? 'b-returned' : 'b-new'}`}>{STATE_UZ[t.state] ?? t.state}{t.not_before ? ` · ${tash(t.not_before)}` : ''}</span></span>
              <span className="small">{t.customer_name ?? '—'} · {t.items_text}</span>
              {SLA_UZ[t.sla] && <span className={`sla-pill ${SLA_UZ[t.sla][1]}`}>{SLA_UZ[t.sla][0]}</span>}
              <span className="small desk-next">➜ {t.next_action}</span>
            </button>
          ))}
        </div>
      )}
      <MyReviews />
      {task && <TaskCard task={task} order={order} lang={lang} busy={busy} onClose={() => { setTask(null); setOrder(null); }}
        onAct={(path, body, done) => run(() => api(`/ops/center/tasks/${task.id}/${path}`, { method: 'POST', body: { expected_version: task.version, ...body } }), () => { if (done) { setTask(null); setOrder(null); } else void openTask(task.id); }, okText(path, body))} />}
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
            {order.lines?.map((l: any) => <div key={l.id} className="spread small"><span>{pick(l.product_snapshot.name, lang)} × {order.commercial_status === 'cancelled' ? l.qty : l.qty - (l.canceled_qty ?? 0)}</span><span>{som(l.line_net_minor)}</span></div>)}
            <div className="spread"><b>Jami (yetkazish bilan)</b><b>{som(order.payable_minor)}</b></div>
            <div className="small muted">{[order.address_snapshot?.district, order.address_snapshot?.street, order.address_snapshot?.house].filter((x: any) => x && x !== '-').join(', ') || 'Manzil hali yo‘q'}</div>
          </div>
        )}
        <ProductFacts taskId={task.id} lang={lang} />
        <DuplicatePanel taskId={task.id} canAct={task.mine} />
        <TaskPartnerRequests taskId={task.id} />
        <Composer taskId={task.id} />
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
            <HandoffForm busy={busy} onSend={(to, pkg) => onAct('handoff', { to_user_id: to, package: pkg }, false)} />
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

function HandoffForm({ busy, onSend }: { busy: boolean; onSend: (to: string, pkg: any) => void }) {
  const [ops, setOps] = useState<any[] | null>(null);
  const [to, setTo] = useState('');
  const [p, setP] = useState({ done: '', customer_said: '', promised: '', missing: '', next: '' });
  const upd = (k: keyof typeof p) => (e: any) => setP({ ...p, [k]: e.target.value });
  return (
    <details className="task-more" onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && !ops) api('/ops/center/operators').then((r) => setOps(r.items)).catch(() => setOps([])); }}>
      <summary>Boshqa operatorga topshirish</summary>
      <p className="muted small">Qabul qilinguncha ish sizda qoladi. Yangi operator mijozdan hammasini qayta so‘ramasligi uchun to‘ldiring.</p>
      <label htmlFor="ho-to">Kimga</label>
      <select id="ho-to" value={to} onChange={(e) => setTo(e.target.value)}>
        <option value="">— tanlang —</option>
        {(ops ?? []).map((o) => <option key={o.id} value={o.id}>{o.display_name}{o.shift === 'working' ? ' (ishda)' : ''}</option>)}
      </select>
      <label htmlFor="ho-done">Nima qilindi *</label><textarea id="ho-done" rows={2} value={p.done} onChange={upd('done')} />
      <label htmlFor="ho-said">Mijoz nima dedi</label><input id="ho-said" value={p.customer_said} onChange={upd('customer_said')} />
      <label htmlFor="ho-prom">Nima va’da qilindi</label><input id="ho-prom" value={p.promised} onChange={upd('promised')} />
      <label htmlFor="ho-miss">Nima yetishmaydi</label><input id="ho-miss" value={p.missing} onChange={upd('missing')} />
      <label htmlFor="ho-next">Keyingi qadam *</label><input id="ho-next" value={p.next} onChange={upd('next')} />
      <button className="btn secondary full mt8" disabled={busy || !to || p.done.length < 2 || p.next.length < 2} onClick={() => onSend(to, p)}>Topshirish so‘rovini yuborish</button>
    </details>
  );
}

const PR_KIND: Record<string, string> = { callback_time: 'Qo‘ng‘iroq vaqtini o‘zgartirish', address: 'Manzilni to‘ldirish', variant_change: 'Variantni almashtirish', commission_question: 'Komissiya savoli', message: 'Mas’ulga xabar' };
/** Partner requests of this order; the answer typed here is what the partner sees (internal notes stay separate). */
function TaskPartnerRequests({ taskId }: { taskId: string }) {
  const [items, setItems] = useState<any[]>([]);
  const [ans, setAns] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => { api(`/ops/center/tasks/${taskId}/partner-requests`).then((r) => setItems(r.items)).catch(() => {}); }, [taskId]);
  useEffect(load, [load]);
  if (!items.length) return null;
  return (
    <div className="task-preq">
      <b>Hamkor so‘rovlari</b>
      {items.map((r) => (
        <div key={r.id} className="preq-item">
          <div className="spread small"><span>🤝 {r.partner_name} · {PR_KIND[r.kind] ?? r.kind}</span><span className={`pill ${r.status === 'answered' ? 'b-delivered' : 'b-accepted'}`}>{r.status === 'answered' ? 'Javob berildi' : 'Javob kutilmoqda'}</span></div>
          <div className="small">{r.body}{r.preferred_at ? ` · 📞 ${tash(r.preferred_at)}` : ''}</div>
          {r.answer ? <div className="preq-ans small">💬 {r.answer}</div> : (
            <>
              <label className="small" htmlFor={`pa-${r.id}`}>Hamkorga javob (hamkor shu matnni ko‘radi)</label>
              <textarea id={`pa-${r.id}`} rows={2} value={ans[r.id] ?? ''} onChange={(e) => setAns({ ...ans, [r.id]: e.target.value })} />
              <button className="btn secondary sm" disabled={(ans[r.id] ?? '').trim().length < 2} onClick={async () => { try { await api(`/ops/center/partner-requests/${r.id}/answer`, { method: 'POST', body: { answer: ans[r.id] } }); setMsg('✓ Javob yuborildi'); load(); } catch (e: any) { setMsg(errText(e)); } }}>Javob yuborish</button>
            </>
          )}
        </div>
      ))}
      {msg && <div className="small" role="status">{msg}</div>}
    </div>
  );
}

const AUD: [string, string, string][] = [['internal', '🔒 Ichki izoh', 'Faqat xodimlar ko‘radi'], ['partner', '🤝 Hamkorga', 'Hamkor kabinetida va Telegram’da ko‘radi'], ['customer', '👤 Mijozga', 'Mijoz buyurtma sahifasida ko‘radi']];
const DELIV: Record<string, string> = { stored: 'kabinetda ko‘rinadi', queued: 'yuborish navbatida', sent: 'yuborildi', failed: 'yuborilmadi', unknown: 'natija noma’lum' };
/** Three-audience composer: the audience is always named before sending; internal notes never leave the team. */
function Composer({ taskId }: { taskId: string }) {
  const [aud, setAud] = useState('internal');
  const [text, setText] = useState('');
  const [items, setItems] = useState<any[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [tpls, setTpls] = useState<any[]>([]);
  const [script, setScript] = useState<'latn' | 'cyrl'>('latn');
  const load = useCallback(() => { api(`/ops/center/tasks/${taskId}/messages`).then((r) => setItems(r.items)).catch(() => {}); }, [taskId]);
  useEffect(load, [load]);
  useEffect(() => { api(`/ops/center/tasks/${taskId}/templates?script=${script}`).then((r) => setTpls(r.items)).catch(() => {}); }, [taskId, script]);
  const cur = AUD.find((a) => a[0] === aud)!;
  const unfilled = text.match(/\{[a-z_]+\}/g);
  return (
    <details className="task-more composer">
      <summary>Xabar / izoh yozish {items.length ? `(${items.length})` : ''}</summary>
      <div className="seg aud-seg" role="radiogroup" aria-label="Kimga">
        {AUD.map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={aud === k} className={aud === k ? 'on' : ''} onClick={() => setAud(k)}>{l}</button>)}
      </div>
      <p className={`aud-note aud-${aud}`}>Kimga: <b>{cur[1]}</b> — {cur[2]}</p>
      {aud !== 'internal' && tpls.some((t) => t.audience === aud) && (
        <div className="tpl-row">
          <label className="sr-only" htmlFor={`tpl-${taskId}`}>Tayyor javob</label>
          <select id={`tpl-${taskId}`} value="" onChange={(e) => { const t = tpls.find((x) => x.id === e.target.value); if (t) setText(t.text); }}>
            <option value="">📄 Tayyor javobni tanlash…</option>
            {tpls.filter((t) => t.audience === aud).map((t) => <option key={t.id} value={t.id}>{t.title}{t.missing.length ? ' (to‘ldirish kerak)' : ''}</option>)}
          </select>
          <button type="button" className="btn secondary sm" onClick={() => setScript(script === 'latn' ? 'cyrl' : 'latn')}>{script === 'latn' ? 'Кирилл' : 'Lotin'}</button>
        </div>
      )}
      <textarea rows={3} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} aria-label={`Matn: ${cur[1]}`} />
      {unfilled && aud !== 'internal' && <p className="field-error small">To‘ldiring: {[...new Set(unfilled)].join(', ')} — noma’lum ma’lumotni taxmin qilib yozmang.</p>}
      <button className="btn secondary full" disabled={text.trim().length < 2 || (!!unfilled && aud !== 'internal')} onClick={async () => {
        setMsg(null);
        try { const r = await api(`/ops/center/tasks/${taskId}/messages`, { method: 'POST', body: { audience: aud, body: text } }); setText(''); setMsg(r.delivery_state === 'no_partner' ? 'Bu buyurtmada hamkor yo‘q.' : `✓ Saqlandi (${DELIV[r.delivery_state] ?? r.delivery_state})`); load(); } catch (e: any) { setMsg(errText(e)); }
      }}>{aud === 'internal' ? 'Izohni saqlash' : 'Yuborish'}</button>
      {msg && <div className="small" role="status">{msg}</div>}
      {items.length > 0 && <ul className="msg-list">{items.map((m) => <li key={m.id} className={`aud-${m.audience}`}><span className="small"><b>{AUD.find((a) => a[0] === m.audience)?.[1]}</b> · {m.author} · {tash(m.created_at)}{m.audience !== 'internal' ? ` · ${DELIV[m.delivery_state] ?? m.delivery_state}` : ''}</span><span>{m.body}</span></li>)}</ul>}
    </details>
  );
}

/** Possible duplicates with evidence; the operator decides (nothing is merged or cancelled automatically). */
function DuplicatePanel({ taskId, canAct }: { taskId: string; canAct: boolean }) {
  const [d, setD] = useState<any>(null);
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => { api(`/ops/center/tasks/${taskId}/duplicates`).then(setD).catch(() => {}); }, [taskId]);
  useEffect(load, [load]);
  if (!d || (!d.items.length && !d.order.review)) return null;
  const decide = async (decision: string, keep?: string) => {
    setMsg(null);
    try { await api(`/ops/center/tasks/${taskId}/duplicate-decision`, { method: 'POST', body: { decision, keep_order_id: keep, reason } }); setMsg(decision === 'duplicate' ? '✓ Bu buyurtma takror deb bekor qilindi (asl buyurtma saqlandi)' : '✓ Takror emas deb belgilandi'); load(); }
    catch (e: any) { setMsg(e.code === 'PAID_ORDER_REQUIRES_REFUND' ? 'To‘langan buyurtmani bu yerda bekor qilib bo‘lmaydi — qaytarish jarayoni orqali.' : errText(e)); }
  };
  return (
    <div className="dup-box">
      <b>⚠️ Takror bo‘lishi mumkin</b>
      {d.order.review ? <p className="small">Qaror: {d.order.review === 'duplicate' ? 'takror — bekor qilingan' : 'takror emas'}</p> : <p className="muted small">Bir xil telefon — dalil emas, faqat signal. Bir raqamda oila a’zolari ham buyurtma berishi mumkin.</p>}
      {d.items.map((o: any) => (
        <div key={o.id} className="dup-item small">
          <div className="spread"><b>{o.number}</b><span>{o.minutes_apart < 60 ? `${o.minutes_apart} daq farq` : `${Math.round(o.minutes_apart / 60)} soat farq`}</span></div>
          <div>{o.customer_name ?? '—'} · {o.district ?? '—'} · {o.channel}</div>
          {o.shared_items && <div>Bir xil mahsulot: {o.shared_items}</div>}
          {canAct && !d.order.review && <button className="btn secondary sm" disabled={reason.trim().length < 3} onClick={() => { if (confirm(`Joriy buyurtma ${o.number} ning takrori deb bekor qilinsinmi?`)) void decide('duplicate', o.id); }}>Bu — {o.number} ning takrori</button>}
        </div>
      ))}
      {canAct && !d.order.review && (
        <>
          <label className="small" htmlFor={`dup-r-${taskId}`}>Sabab (majburiy)</label>
          <input id={`dup-r-${taskId}`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Masalan: mijoz ikki marta bosgan / aka-uka alohida buyurtma" />
          <button className="btn secondary sm" disabled={reason.trim().length < 3} onClick={() => decide('not_duplicate')}>Takror emas</button>
        </>
      )}
      {msg && <div className="small" role="status">{msg}</div>}
    </div>
  );
}

/** Verified product facts (stock now, price now vs ordered, warranty, description) — never quoted from memory. */
function ProductFacts({ taskId, lang }: { taskId: string; lang: any }) {
  const [d, setD] = useState<any>(null);
  useEffect(() => { api(`/ops/center/tasks/${taskId}/product-facts`).then(setD).catch(() => {}); }, [taskId]);
  if (!d?.items?.length) return null;
  return (
    <details className="task-more facts">
      <summary>📦 Mahsulot ma’lumoti (katalogdan)</summary>
      {d.items.map((x: any) => {
        const changed = x.current_unit_minor && x.current_unit_minor !== x.ordered_unit_minor;
        return (
          <div key={x.line_id} className="fact-item small">
            <b>{pick(x.name, lang)}{x.variant && Object.values(x.variant).length ? ` (${Object.values(x.variant).join('/')})` : ''} × {x.qty}</b>
            <span>SKU: {x.sku_code} · Omborda hozir: <b className={x.available < x.qty ? 'warn-t' : ''}>{x.available} dona</b></span>
            <span>Buyurtmadagi narx: {som(x.ordered_unit_minor)}{changed ? ` · hozirgi narx: ${som(x.current_unit_minor)} (buyurtma narxi o‘zgarmaydi)` : ''}</span>
            {x.warranty_months ? <span>Kafolat: {x.warranty_months} oy</span> : <span className="muted">Kafolat ko‘rsatilmagan — va’da bermang</span>}
            {x.description && <span className="muted">{x.description}</span>}
            <a href={`/p/${x.slug}`} target="_blank" rel="noopener noreferrer">Mahsulot sahifasi ↗</a>
          </div>
        );
      })}
      <p className="muted small">Tekshirilgan: {tash(d.checked_at)}</p>
    </details>
  );
}

/** The operator's own QA reviews, with a one-time objection (spec §25). */
function MyReviews() {
  const [items, setItems] = useState<any[]>([]);
  const [reply, setReply] = useState<Record<string, string>>({});
  const load = useCallback(() => { api('/ops/center/qa/mine').then((r) => setItems(r.items)).catch(() => {}); }, []);
  useEffect(load, [load]);
  if (!items.length) return null;
  return (
    <details className="task-more">
      <summary>Mening baholarim ({items.length})</summary>
      {items.map((q) => (
        <div key={q.id} className="fact-item small">
          <div className="spread"><b>{q.number}</b><span>Baho: {q.score}/5</span></div>
          <span>{q.checks.correct_outcome ? '✓' : '✗'} natija · {q.checks.data_complete ? '✓' : '✗'} ma’lumot · {q.checks.clear_communication ? '✓' : '✗'} muloqot</span>
          {q.note && <span>Izoh: {q.note}</span>}
          {q.operator_reply ? <span className="muted">Sizning javobingiz: {q.operator_reply}</span> : (
            <>
              <input value={reply[q.id] ?? ''} onChange={(e) => setReply({ ...reply, [q.id]: e.target.value })} placeholder="E’tiroz yoki izoh (bir marta)" aria-label="E’tiroz" />
              <button className="btn secondary sm" disabled={(reply[q.id] ?? '').trim().length < 3} onClick={async () => { try { await api(`/ops/center/qa/reviews/${q.id}/reply`, { method: 'POST', body: { text: reply[q.id] } }); load(); } catch { /* shown on reload */ } }}>Yuborish</button>
            </>
          )}
        </div>
      ))}
    </details>
  );
}
