'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, som } from '@/lib/api';
import { errText } from '@/lib/errors';
import { toast } from '@/lib/toast';
import { dt, fmtScore, METRIC_UZ, STATUS_UZ } from '../partner/contests/shared';

const NEXT: Record<string, [string, string][]> = {
  draft: [['submit', 'Ko‘rib chiqishga yuborish']], review: [['approve', 'Tasdiqlash (egasi)']], approved: [['publish', 'E’lon qilish (egasi)']],
  scheduled: [['pause', 'To‘xtatish']], active: [['pause', 'To‘xtatish']], paused: [['resume', 'Davom ettirish']],
  calculating: [['close', 'Yopish: dastlabki natija + e’tiroz muddati']], appeal_window: [['finalize', 'Yakuniy tasdiqlash (egasi)']], finalized: [['award', 'Sovrinlarni berish (egasi)']],
};
const toIsoLocal = (d: Date) => new Date(d.getTime() + 5 * 3600e3).toISOString().slice(0, 16);

/** Admin "Konkurs markazi": create (draft), status flow with owner approvals, dry-run, appeals, prizes. */
export function ContestCenterAdmin() {
  const [list, setList] = useState<any[] | null>(null);
  const [week, setWeek] = useState<any>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [form, setForm] = useState<any>(null);
  const load = useCallback(() => { api('/admin/cc/contests').then((r) => { setList(r.items); setWeek(r.week); }).catch((e) => toast(errText(e), 'err')); }, []);
  useEffect(load, [load]);
  const newForm = () => setForm({ title_latn: '', description: '', metric: 'settled_orders', starts: week ? toIsoLocal(new Date(week.starts_at)) : '', ends: week ? toIsoLocal(new Date(week.ends_at)) : '', min_score: 1, appeal_days: 3, terms: '', prizes: [{ place: 1, title: '', kind: 'money', value: '' }] });
  return (
    <section style={{ marginTop: 12 }} className="cc">
      <div className="spread"><h2>Konkurs markazi</h2>{!form && <button className="btn sm" onClick={newForm}>＋ Yangi konkurs</button>}</div>
      <p className="muted small">Natija faqat yetkazilgan va to‘langan buyurtmalardan (komissiya ledgeridan) hisoblanadi. Tasdiqlash, e’lon qilish, yakunlash va sovrin berish — faqat egasi.</p>
      {form && <ContestForm f={form} setF={setForm} onDone={() => { setForm(null); load(); }} />}
      {list === null && <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>}
      <div className="slist">
        {list?.map((c) => (
          <button key={c.id} type="button" className={`scard cc-card ${sel === c.id ? 'sel' : ''}`} onClick={() => setSel(sel === c.id ? null : c.id)}>
            <div className="spread"><b>{c.title_latn}</b><span className={`pill ${STATUS_UZ[c.status]?.[1] ?? ''}`}>{STATUS_UZ[c.status]?.[0] ?? c.status}</span></div>
            <div className="small muted">{dt(c.starts_at)} — {dt(c.ends_at)} · {METRIC_UZ[c.metric]} · {c.participants} qatnashchi · v{c.current_version}</div>
          </button>
        ))}
      </div>
      {sel && <ContestPanel id={sel} onChanged={load} />}
    </section>
  );
}

function ContestForm({ f, setF, onDone }: { f: any; setF: (x: any) => void; onDone: () => void }) {
  const u = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    try {
      await api('/admin/cc/contests', { method: 'POST', body: {
        title_latn: f.title_latn, description: f.description || undefined, metric: f.metric, starts_at: new Date(`${f.starts}:00+05:00`).toISOString(), ends_at: new Date(`${f.ends}:00+05:00`).toISOString(),
        min_score: Number(f.min_score) || 0, appeal_days: Number(f.appeal_days) || 0, terms: f.terms || undefined,
        prizes: f.prizes.filter((p: any) => p.title.trim()).map((p: any) => ({ place: Number(p.place) || null, title: p.title, kind: p.kind, value_minor: p.kind === 'money' ? Number(p.value || 0) * 100 : p.kind === 'uzcoin' ? Number(p.value || 0) : 0, qty: 1 })),
      } });
      toast('✓ Qoralama saqlandi — endi ko‘rib chiqishga yuboring'); onDone();
    } catch (e: any) { toast(errText(e), 'err'); }
  };
  return (
    <div className="card cc-form">
      <label htmlFor="cc-t">Nomi</label><input id="cc-t" value={f.title_latn} onChange={u('title_latn')} placeholder="Masalan: Haftaning eng yaxshi sotuvchisi" />
      <label htmlFor="cc-d">Qisqa tavsif</label><textarea id="cc-d" rows={2} value={f.description} onChange={u('description')} />
      <label htmlFor="cc-m">Nima bo‘yicha</label>
      <select id="cc-m" value={f.metric} onChange={u('metric')}>{Object.entries(METRIC_UZ).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      <div className="bulk-row">
        <div><label htmlFor="cc-s">Boshlanishi (Toshkent)</label><input id="cc-s" type="datetime-local" value={f.starts} onChange={u('starts')} /></div>
        <div><label htmlFor="cc-e">Tugashi</label><input id="cc-e" type="datetime-local" value={f.ends} onChange={u('ends')} /></div>
      </div>
      <div className="bulk-row">
        <div><label htmlFor="cc-min">Eng kam natija</label><input id="cc-min" inputMode="numeric" value={f.min_score} onChange={u('min_score')} /></div>
        <div><label htmlFor="cc-ap">E’tiroz muddati (kun)</label><input id="cc-ap" inputMode="numeric" value={f.appeal_days} onChange={u('appeal_days')} /></div>
      </div>
      <b>Sovrinlar</b>
      {f.prizes.map((p: any, i: number) => (
        <div key={i} className="cc-prize">
          <input aria-label="O‘rin" inputMode="numeric" value={p.place} onChange={(e) => { const x = [...f.prizes]; x[i] = { ...p, place: e.target.value }; setF({ ...f, prizes: x }); }} style={{ width: 56 }} />
          <input aria-label="Sovrin nomi" value={p.title} placeholder="Sovrin" onChange={(e) => { const x = [...f.prizes]; x[i] = { ...p, title: e.target.value }; setF({ ...f, prizes: x }); }} />
          <select aria-label="Turi" value={p.kind} onChange={(e) => { const x = [...f.prizes]; x[i] = { ...p, kind: e.target.value }; setF({ ...f, prizes: x }); }}><option value="money">Pul</option><option value="uzcoin">UzCoin</option><option value="item">Buyum</option></select>
          {p.kind === 'uzcoin' && <input aria-label="UzCoin soni" inputMode="numeric" value={p.value} placeholder="coin" onChange={(e) => { const x = [...f.prizes]; x[i] = { ...p, value: e.target.value.replace(/\D/g, '') }; setF({ ...f, prizes: x }); }} style={{ width: 90 }} />}
          {p.kind === 'money' && <input aria-label="Summa so‘m" inputMode="numeric" value={p.value} placeholder="so‘m" onChange={(e) => { const x = [...f.prizes]; x[i] = { ...p, value: e.target.value.replace(/\D/g, '') }; setF({ ...f, prizes: x }); }} style={{ width: 110 }} />}
        </div>
      ))}
      <button className="link-btn small" onClick={() => setF({ ...f, prizes: [...f.prizes, { place: f.prizes.length + 1, title: '', kind: 'money', value: '' }] })}>＋ Sovrin qo‘shish</button>
      <label htmlFor="cc-terms">Shartlar matni (hamkor ko‘radi)</label><textarea id="cc-terms" rows={3} value={f.terms} onChange={u('terms')} />
      <div className="row" style={{ gap: 8 }}><button className="btn" disabled={f.title_latn.trim().length < 3 || !f.starts || !f.ends} onClick={save}>Qoralamani saqlash</button><button className="btn secondary" onClick={() => setF(null)}>Bekor</button></div>
    </div>
  );
}

function ContestPanel({ id, onChanged }: { id: string; onChanged: () => void }) {
  const [d, setD] = useState<any>(null);
  const [sim, setSim] = useState<any>(null);
  const load = useCallback(() => { api(`/admin/cc/contests/${id}`).then(setD).catch((e) => toast(errText(e), 'err')); }, [id]);
  useEffect(() => { setSim(null); load(); }, [load]);
  if (!d) return <div className="loading" role="status"><span className="spinner" aria-hidden />…</div>;
  const v = d.versions.find((x: any) => x.version === d.current_version);
  const act = async (name: string) => {
    let body: any = {};
    if (name === 'cancel') { const reason = prompt('Bekor qilish sababi'); if (!reason) return; body = { reason }; }
    try { await api(`/admin/cc/contests/${id}/${name}`, { method: 'POST', body }); toast('✓ Bajarildi'); load(); onChanged(); }
    catch (e: any) { toast(e.code === 'OWNER_APPROVAL_REQUIRED' ? 'Bu amal faqat egasi uchun.' : e.code === 'APPEAL_WINDOW_OPEN' ? 'E’tiroz muddati hali tugamagan.' : e.code === 'APPEALS_OPEN' ? 'Ochiq e’tirozlar bor — avval ularni hal qiling.' : errText(e), 'err'); }
  };
  return (
    <div className="card cc-panel">
      <div className="spread"><b>{v.title_latn}</b><span className="small muted">v{d.current_version} · {d.participants} qatnashchi</span></div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {(NEXT[d.status] ?? []).map(([k, l]) => <button key={k} className="btn sm" onClick={() => act(k)}>{l}</button>)}
        {!['draft', 'review', 'approved', 'canceled'].includes(d.status) && <button className="btn secondary sm" onClick={() => act('recompute')}>Qayta hisoblash</button>}
        <button className="btn secondary sm" onClick={async () => { try { setSim(await api(`/admin/cc/contests/${id}/simulate`, { method: 'POST' })); } catch (e: any) { toast(errText(e), 'err'); } }}>Sinov hisobi (dry-run)</button>
        {!['canceled', 'awarded', 'finalized'].includes(d.status) && <button className="btn secondary sm danger-t" onClick={() => act('cancel')}>Bekor qilish</button>}
        {d.snapshots.length > 0 && <a className="btn secondary sm" href={`/api/v1/admin/cc/contests/${id}/export.csv`}>CSV</a>}
      </div>
      {d.appeal_deadline && <p className="small">E’tiroz muddati: {dt(d.appeal_deadline)}</p>}
      {sim && <div className="small"><b>Sinov natijasi (hech narsa yozilmadi, {dt(sim.as_of)}):</b>{sim.rows.length === 0 && <p className="muted">Mos buyurtma yo‘q.</p>}{sim.rows.slice(0, 10).map((r: any) => <div key={r.partner_id} className="spread w-prod"><span>#{r.rank ?? '—'} {r.name}</span><b>{fmtScore(v.metric, r.score)}</b></div>)}</div>}
      {d.prizes.length > 0 && <div className="small"><b>Sovrinlar:</b> {d.prizes.map((p: any) => `${p.place ? `${p.place}-o‘rin` : p.nomination}: ${p.title}${p.kind === 'money' ? ` (${som(p.value_minor)})` : ''} [${p.awarded}/${p.qty}]`).join(' · ')}</div>}
      {d.awards.length > 0 && <div className="small"><b>Berilgan:</b> {d.awards.map((a: any) => `${a.rank ? `#${a.rank} ` : ''}${a.display_name} — ${a.title} (${a.status})`).join('; ')}</div>}
      {d.appeals.length > 0 && <div className="small"><b>E’tirozlar</b>{d.appeals.map((a: any) => (
        <div key={a.id} className="w-prod"><div>{a.display_name} ({a.code}): {a.body}</div>
          {a.status === 'open' ? <div className="row" style={{ gap: 6 }}>{(['accepted', 'rejected'] as const).map((st) => <button key={st} className="btn secondary sm" onClick={async () => { const resolution = prompt('Qaror izohi'); if (!resolution) return; try { await api(`/admin/cc/appeals/${a.id}/resolve`, { method: 'POST', body: { status: st, resolution } }); load(); } catch (e: any) { toast(errText(e), 'err'); } }}>{st === 'accepted' ? 'Qabul' : 'Rad'}</button>)}</div> : <div className="muted">{a.status === 'accepted' ? 'Qabul qilindi' : 'Rad etildi'}: {a.resolution}</div>}
        </div>))}</div>}
      {d.versions.length > 1 && <div className="small muted">Qoidalar tarixi: {d.versions.filter((x: any) => x.version > 1).map((x: any) => `v${x.version}: ${x.reason}`).join('; ')}</div>}
    </div>
  );
}
