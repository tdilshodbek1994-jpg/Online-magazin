'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, som } from '@/lib/api';
import { errText } from '@/lib/errors';
import { toast } from '@/lib/toast';

const PRESETS: [number, string][] = [[50, '0,5%'], [100, '1%'], [200, '2%'], [500, '5%']];
const SRC_UZ: Record<string, string> = { one_time: 'Bir martalik', auto: 'Avtomatik' };
const ST_UZ: Record<string, string> = { transferred_to_fund: 'Fondga o‘tdi', pending_eligibility: 'Kutilmoqda', reserved: 'Band', reversed: 'Tuzatildi', failed: 'Xato', disputed: 'Nizoli' };

/** Partner «Xayriya markazi»: totals, one-time gift, automatic % of own confirmed commission (opt-in), history, funds. */
export default function CharityCenter() {
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const [tab, setTab] = useState<'once' | 'auto' | 'history' | 'funds'>('once');
  const [amt, setAmt] = useState('');
  const [fund, setFund] = useState('');
  const [bps, setBps] = useState(100);
  const [custom, setCustom] = useState('');
  const [cap, setCap] = useState('');
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { api('/partner/charity/center').then((x) => { setD(x); if (x.rule) setBps(x.rule.percent_bps); }).catch(setErr); }, []);
  useEffect(load, [load]);
  if (err) return <div className="notice" role="alert">{errText(err)}</div>;
  if (!d) return <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>;
  const t = d.totals;
  const pct = custom ? Math.round(Number(custom.replace(',', '.')) * 100) : bps;
  const example = (base: number) => som(String(Math.round((base * 100 * pct) / 10000)));
  return (
    <div className="cc">
      <h1>Xayriya markazi</h1>
      <div className="watch-money">
        <div><span>Men ajratdim</span><b>{som(t.my_given_minor)}</b></div>
        <div><span>Kutilmoqda</span><b>{som(t.projected_pending_minor)}</b></div>
        <div><span>Fondga o‘tgan (jami)</span><b>{som(t.shop_to_fund_minor)}</b></div>
      </div>
      <p className="small muted">Qabul qiluvchiga topshirilgan: <b>{som(t.shop_disbursed_minor)}</b>{t.shop_disbursement_pending_minor !== '0' ? ` · topshirish jarayonida: ${som(t.shop_disbursement_pending_minor)}` : ''}. «Kutilmoqda» — hali ochilmagan komissiyangizdan taxminiy ulush, pul hali ko‘chmagan.</p>
      <div className="chips" role="tablist">{([['once', 'Bir martalik'], ['auto', 'Avtomatik'], ['history', 'Tarix'], ['funds', 'Fondlar']] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`chip ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{l}</button>)}</div>

      {tab === 'once' && (
        <section className="card cc-form">
          <label htmlFor="ch-amt">Summa (so‘m) — «Yechish mumkin» balansingizdan</label>
          <input id="ch-amt" inputMode="numeric" value={amt} onChange={(e) => setAmt(e.target.value.replace(/\D/g, '').slice(0, 10))} />
          {d.funds.length > 0 && <><label htmlFor="ch-f">Fond</label><select id="ch-f" value={fund} onChange={(e) => setFund(e.target.value)}><option value="">Umumiy hayriya qutisi</option>{d.funds.map((f: any) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></>}
          <button className="btn" disabled={busy || !amt || amt === '0'} onClick={async () => {
            setBusy(true);
            try { await api('/partner/charity', { method: 'POST', idem: crypto.randomUUID(), body: { amount_minor: String(BigInt(amt) * 100n), ...(fund ? { fund_id: fund } : {}) } }); toast('✓ Rahmat! Hayriya fondga o‘tdi'); setAmt(''); load(); }
            catch (e: any) { toast(e.code === 'INSUFFICIENT_AVAILABLE' ? 'Balansingizda yetarli mablag‘ yo‘q.' : errText(e), 'err'); } finally { setBusy(false); }
          }}>Hayriya qilish</button>
        </section>
      )}

      {tab === 'auto' && (
        <section className="card cc-form">
          {d.rule && <p className="small">Hozir: <b>{d.rule.percent_bps / 100}%</b> · {d.rule.status === 'active' ? <span className="ok-t">yoqilgan</span> : d.rule.status === 'paused' ? 'pauzada' : 'o‘chirilgan'}{d.rule.monthly_cap_minor ? ` · oylik limit ${som(d.rule.monthly_cap_minor)}` : ''}</p>}
          <p className="small muted">Faqat <b>sizning tasdiqlangan komissiyangizdan</b> — komissiya «yechish mumkin» bo‘lganda ajratiladi. Do‘kon tushumidan emas. Istalgan payt o‘chirasiz; o‘tgan ajratmalar o‘zgarmaydi.</p>
          <div className="chips">{PRESETS.map(([v, l]) => <button key={v} className={`chip ${!custom && bps === v ? 'on' : ''}`} onClick={() => { setBps(v); setCustom(''); }}>{l}</button>)}</div>
          <label htmlFor="ch-c">Yoki o‘z foizingiz (%)</label><input id="ch-c" inputMode="decimal" value={custom} onChange={(e) => setCustom(e.target.value.replace(/[^\d.,]/g, '').slice(0, 5))} placeholder="masalan 1,5" />
          <label htmlFor="ch-cap">Oylik limit (so‘m, ixtiyoriy)</label><input id="ch-cap" inputMode="numeric" value={cap} onChange={(e) => setCap(e.target.value.replace(/\D/g, '').slice(0, 10))} />
          <p className="small">Misol: 30 000 so‘mlik komissiyadan <b>{example(30_000)}</b>, 300 000 dan <b>{example(300_000)}</b> ajratiladi.</p>
          <label className="s-check"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> Komissiyamdan {pct / 100}% avtomatik hayriyaga ajratilishiga roziman</label>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="btn" disabled={!agree || pct < 1 || pct > 10000} onClick={async () => { try { await api('/partner/charity/rule', { method: 'PUT', body: { consent: true, percent_bps: pct, ...(cap ? { monthly_cap_minor: Number(cap) * 100 } : {}), ...(fund ? { fund_id: fund } : {}) } }); toast('✓ Avtomatik hayriya yoqildi'); setAgree(false); load(); } catch (e: any) { toast(errText(e), 'err'); } }}>Saqlash</button>
            {d.rule?.status === 'active' && <button className="btn secondary" onClick={async () => { await api('/partner/charity/rule/pause', { method: 'POST' }).catch(() => {}); load(); }}>Pauza</button>}
            {d.rule?.status === 'paused' && <button className="btn secondary" onClick={async () => { await api('/partner/charity/rule/resume', { method: 'POST' }).catch(() => {}); load(); }}>Davom ettirish</button>}
            {d.rule && d.rule.status !== 'canceled' && <button className="btn secondary danger-t" onClick={async () => { if (!confirm('Avtomatik hayriya o‘chirilsinmi?')) return; await api('/partner/charity/rule/cancel', { method: 'POST' }).catch(() => {}); load(); }}>O‘chirish</button>}
          </div>
        </section>
      )}

      {tab === 'history' && (
        <section className="card">
          {d.history.length === 0 && <p className="muted small">Hali hayriya yo‘q.</p>}
          {d.history.map((h: any) => <div key={h.id} className="spread small w-prod"><span>{new Date(h.created_at).toLocaleDateString('uz-UZ')} · {SRC_UZ[h.source]}{h.percent_bps ? ` ${h.percent_bps / 100}% · komissiya ${som(h.commission_amount_minor)}` : ''}{h.fund ? ` · ${h.fund}` : ''}</span><b>{som(h.amount_minor)} <span className="muted">{ST_UZ[h.status]}</span></b></div>)}
        </section>
      )}

      {tab === 'funds' && (
        <section className="card">
          {d.funds.length === 0 && <p className="muted small">Hozircha tasdiqlangan fond yo‘q — hayriya umumiy qutiga tushadi.</p>}
          {d.funds.map((f: any) => <div key={f.id} className="w-prod small"><b>{f.name}</b><div className="muted">{f.recipient_org}{f.purpose ? ` — ${f.purpose}` : ''}</div></div>)}
          {d.handovers.length > 0 && <><b className="small">Topshirilganlar</b>{d.handovers.map((h: any, i: number) => <div key={i} className="spread small w-prod"><span>{h.recipient}{h.fund ? ` · ${h.fund}` : ''}</span><b>{som(h.amount_minor)}</b></div>)}</>}
        </section>
      )}
    </div>
  );
}
