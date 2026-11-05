'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errText } from '@/lib/errors';
import { toast } from '@/lib/toast';

const TRIG: Record<string, string> = { order_unassigned: 'Buyurtmani hech kim olmasa', stock_low: 'Tovar kam qolsa', cod_unremitted: 'Naqd pul kuryerda qolib ketsa' };
const ACT: Record<string, string> = { alert_owner: 'Egasiga ogohlantirish', reorder_draft: 'Xarid qoralamasi (tasdiqsiz sotib olinmaydi)' };
const MODE: Record<string, string> = { shadow: 'Sinov (faqat yozib boradi)', active: 'Faol', paused: 'To‘xtatilgan' };
const OUT: Record<string, string> = { would_do: 'qilgan bo‘lardi', done: 'bajarildi', skipped_cap: 'kunlik limit', failed: 'xato' };

/** Rules: trigger → allowed action. Shadow first, then the owner activates. No money/coin/penalty/ads actions exist. */
export function AutomationAdmin() {
  const [d, setD] = useState<any>(null);
  const [f, setF] = useState({ name: '', trigger: 'order_unassigned', action: 'alert_owner', n: 30 });
  const load = useCallback(() => { api('/admin/automation').then(setD).catch(() => {}); }, []);
  useEffect(load, [load]);
  const create = async () => {
    const params = f.trigger === 'order_unassigned' ? { minutes: f.n } : f.trigger === 'cod_unremitted' ? { days: f.n } : { target_days: f.n };
    try { await api('/admin/automation/rules', { method: 'POST', body: { name: f.name, trigger: f.trigger, action: f.action, params } }); toast('✓ Qoida sinov rejimida yaratildi'); setF({ ...f, name: '' }); load(); } catch (e: any) { toast(errText(e), 'err'); }
  };
  const act = async (path: string, ok: string) => { try { await api(path, { method: 'POST' }); toast(ok); load(); } catch (e: any) { toast(e.code === 'SHADOW_RUN_REQUIRED' ? 'Avval sinov natijasini ko‘ring («Hozir tekshirish»).' : e.code === 'STEP_UP_REQUIRED' ? 'Avval qayta tasdiqlang (MFA).' : errText(e), 'err'); } };
  if (!d) return <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>;
  const unit = f.trigger === 'order_unassigned' ? 'daqiqa' : f.trigger === 'cod_unremitted' ? 'kun' : 'kunlik zaxira';
  return (
    <div className="dec">
      <section className="card">
        <div className="dec-head"><h2>Avtomatik qoidalar</h2><button className="btn secondary sm" onClick={() => act('/admin/automation/run', '✓ Tekshirildi')}>Hozir tekshirish</button></div>
        <p className="muted small">Yangi qoida avval «sinov» rejimida ishlaydi: nima qilgan bo‘lardi — faqat yozib boradi. Natijani ko‘rib, «Faollashtirish»ni bosing. Pul, coin, jarima va reklama amallari bu yerda yo‘q.</p>
        {d.rules.length === 0 && <p className="muted small">Hali qoida yo‘q.</p>}
        {d.rules.map((r: any) => (
          <div key={r.id} className="dec-item sev4" style={{ cursor: 'default' }}>
            <b className="dec-title">{r.name}</b>
            <span className="dec-meta">{TRIG[r.trigger]} → {ACT[r.action]} · {MODE[r.mode]} · sinovda {r.shadow_runs}, bajarilgan {r.done_runs} · kuniga ≤{r.daily_cap}</span>
            <div className="row" style={{ gap: 6 }}>
              {r.mode !== 'active' && <button className="btn sm" onClick={() => act(`/admin/automation/rules/${r.id}/activate`, '✓ Faollashtirildi')}>Faollashtirish</button>}
              {r.mode !== 'paused' && <button className="btn secondary sm" onClick={() => act(`/admin/automation/rules/${r.id}/pause`, 'To‘xtatildi')}>To‘xtatish</button>}
            </div>
          </div>
        ))}
      </section>
      <section className="card">
        <h2>Yangi qoida</h2>
        <input placeholder="Nomi (masalan: Egasiz buyurtma)" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <select aria-label="Qachon" value={f.trigger} onChange={(e) => { const t = e.target.value; setF({ ...f, trigger: t, action: (d.allowed[t] ?? ['alert_owner'])[0], n: t === 'order_unassigned' ? 30 : t === 'cod_unremitted' ? 2 : 30 }); }}>{Object.entries(TRIG).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <label className="small">Chegara: <input type="number" min={1} value={f.n} onChange={(e) => setF({ ...f, n: Number(e.target.value) })} style={{ width: 90 }} /> {unit}</label>
        <select aria-label="Nima qilsin" value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })}>{(d.allowed[f.trigger] ?? []).map((a: string) => <option key={a} value={a}>{ACT[a]}</option>)}</select>
        <button className="btn" disabled={f.name.trim().length < 3} onClick={create}>Sinov rejimida yaratish</button>
      </section>
      {d.runs.length > 0 && (
        <section className="card">
          <h2>Jurnal</h2>
          <ul className="stp-acts">{d.runs.slice(0, 20).map((x: any, i: number) => <li key={i}><span>{x.detail} <small className="muted">— {OUT[x.outcome]}</small></span><small className="muted">{new Date(x.created_at).toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent', dateStyle: 'short', timeStyle: 'short' })}</small></li>)}</ul>
        </section>
      )}
    </div>
  );
}
