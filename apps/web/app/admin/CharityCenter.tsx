'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, som } from '@/lib/api';
import { errText } from '@/lib/errors';
import { toast } from '@/lib/toast';

const FST: Record<string, string> = { draft: 'Qoralama', review: 'Ko‘rib chiqilmoqda', approved: 'Tasdiqlangan', paused: 'Pauzada', closed: 'Yopilgan' };

/** Admin «Xayriya markazi»: collected ≠ handed over; funds lifecycle; disbursements with proof (two-step for big ones). */
export function CharityCenterAdmin() {
  const [d, setD] = useState<any>(null);
  const [f, setF] = useState({ name: '', recipient_org: '', requisites: '', purpose: '' });
  const load = useCallback(() => { api('/admin/charity/center').then(setD).catch((e) => toast(errText(e), 'err')); }, []);
  useEffect(load, [load]);
  if (!d) return <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>;
  const call = async (fn: () => Promise<any>, ok = '✓ Saqlandi') => { try { const r = await fn(); toast(r?.waiting_for ? 'Ikkinchi tasdiqlovchi kerak' : ok); load(); } catch (e: any) { toast(errText(e), 'err'); } };
  return (
    <section style={{ marginTop: 12 }} className="cc">
      <h2>Xayriya markazi</h2>
      <div className="watch-money">
        <div><span>Yig‘ildi (fondga o‘tdi)</span><b>{som(d.totals.collected)}</b></div>
        <div><span>Topshirish jarayonida</span><b>{som(d.totals.pending)}</b></div>
        <div><span>Qabul qiluvchiga topshirildi</span><b>{som(d.totals.disbursed)}</b></div>
      </div>
      <p className="small muted">Avtomatik ajratma yoqqan hamkorlar: {d.totals.active_rules}. Admin hamkor o‘rniga avtomatik hayriyani yoqa olmaydi. Hayriya tashkiloti, to‘lov va soliq talablarini ishga tushirishdan oldin yurist tekshirsin.</p>
      <h3 className="an-h2">Fondlar</h3>
      {d.funds.map((x: any) => (
        <div key={x.id} className="scard">
          <div className="spread"><b>{x.name}</b><span className="pill">{FST[x.status]}</span></div>
          <div className="small muted">{x.recipient_org ?? 'qabul qiluvchi yozilmagan'} · yig‘ildi {som(x.collected_minor)} · topshirildi {som(x.disbursed_minor)}</div>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {x.status === 'draft' && <button className="btn secondary sm" onClick={() => call(() => api(`/admin/charity/funds/${x.id}/status`, { method: 'POST', body: { status: 'review' } }))}>Ko‘rib chiqishga</button>}
            {['draft', 'review', 'paused'].includes(x.status) && <button className="btn sm" onClick={() => call(() => api(`/admin/charity/funds/${x.id}/status`, { method: 'POST', body: { status: 'approved' } }))}>Tasdiqlash (egasi)</button>}
            {x.status === 'approved' && <button className="btn secondary sm" onClick={() => call(() => api(`/admin/charity/funds/${x.id}/status`, { method: 'POST', body: { status: 'paused' } }))}>Pauza</button>}
            {x.status === 'approved' && <button className="btn secondary sm" onClick={() => { const amount = prompt('Topshiriladigan summa (so‘m)'); const recipient = amount && prompt('Kimga (tashkilot)', x.recipient_org ?? ''); if (amount && recipient) call(() => api('/admin/charity/disbursements', { method: 'POST', body: { fund_id: x.id, amount_minor: Number(amount.replace(/\D/g, '')) * 100, recipient } }), '✓ Topshirish rejalashtirildi — dalil kutilmoqda'); }}>Qabul qiluvchiga topshirish</button>}
          </div>
        </div>
      ))}
      <details className="card pp-more"><summary>＋ Yangi fond</summary>
        {(['name', 'recipient_org', 'requisites', 'purpose'] as const).map((k) => <div key={k}><label htmlFor={`cf-${k}`}>{({ name: 'Nomi', recipient_org: 'Qabul qiluvchi tashkilot', requisites: 'Rekvizitlar', purpose: 'Maqsad' })[k]}</label><input id={`cf-${k}`} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></div>)}
        <button className="btn mt8" disabled={f.name.trim().length < 3} onClick={() => call(() => api('/admin/charity/funds', { method: 'POST', body: Object.fromEntries(Object.entries(f).filter(([, v]) => v)) }).then((r) => { setF({ name: '', recipient_org: '', requisites: '', purpose: '' }); return r; }))}>Saqlash</button>
      </details>
      <h3 className="an-h2">Topshirishlar</h3>
      {d.disbursements.length === 0 && <p className="muted small">Yo‘q.</p>}
      {d.disbursements.map((h: any) => (
        <div key={h.id} className="spread small w-prod"><span>{h.recipient}{h.fund ? ` · ${h.fund}` : ''} · {som(h.amount_minor)}</span>
          {h.status === 'disbursement_pending' ? <button className="btn secondary sm" onClick={() => { const proof = prompt('To‘lov dalili (bank hujjati raqami)'); if (proof) call(() => api(`/admin/charity/disbursements/${h.id}/confirm`, { method: 'POST', body: { proof } }), '✓ Topshirildi'); }}>Dalil bilan tasdiqlash</button> : <b className="ok-t">Topshirildi</b>}
        </div>
      ))}
    </section>
  );
}
