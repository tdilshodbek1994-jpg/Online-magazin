'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { CH_LABEL } from '../analytics/shared';

const today = () => new Date().toISOString().slice(0, 10);
type Alloc = { target: string; mode: 'share' | 'amount'; value: string };

/**
 * Reklama xarajatlari (spec §10): amount + currency (FX frozen at entry, FX_PENDING if no official rate),
 * service period vs payment date, who paid, planned/actual/adjustment, allocation to links/placements, CSV import,
 * reconciliation of provider vs manual rows. Entering an expense never moves wallet money.
 */
export default function Expenses() {
  const [links, setLinks] = useState<any[]>([]);
  const [pls, setPls] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [recon, setRecon] = useState<any[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [f, setF] = useState({ channel: 'telegram_channel', placement_name: '', amount: '', currency: 'UZS', service_from: today(), service_to: today(), paid_at: today(), payer: 'partner', kind: 'actual', note: '' });
  const [allocs, setAllocs] = useState<Alloc[]>([]);
  const [csv, setCsv] = useState('');
  const load = () => {
    api('/partner/ad-expenses?status=all').then((r) => setItems(r.items)).catch(() => {});
    api('/partner/ad-expenses?status=needs_reconcile').then((r) => setRecon(r.items)).catch(() => {});
  };
  useEffect(() => {
    api('/partner/streams').then((r) => setLinks(r.items ?? [])).catch(() => {});
    api('/partner/placements').then((r) => setPls(r.items)).catch(() => {});
    load();
    try { const l = new URLSearchParams(location.search).get('link'); if (l) setAllocs([{ target: `link:${l}`, mode: 'share', value: '100' }]); } catch {}
  }, []);
  const submit = async () => {
    setMsg(null);
    const allocations = allocs.filter((a) => a.target && a.value).map((a) => {
      const [kind, idv] = a.target.split(':');
      return { ...(kind === 'link' ? { root_link_id: idv } : { placement_id: idv }), ...(a.mode === 'share' ? { share_bps: Math.round(Number(a.value) * 100) } : { amount: a.value }) };
    });
    try {
      const r = await api('/partner/ad-expenses', { method: 'POST', idem: crypto.randomUUID(), body: { ...f, amount: f.kind === 'zero_confirmed' ? '0' : f.amount, placement_name: f.placement_name || undefined, note: f.note || undefined, paid_at: f.paid_at || undefined, allocations } });
      setMsg(r.fx_status === 'pending' ? 'Saqlandi. Bu sana uchun rasmiy kurs hali yo‘q — kurs kelguncha jamiga kirmaydi (FX_PENDING).' : 'Saqlandi ✓');
      setF({ ...f, amount: '', note: '', placement_name: '' }); load();
    } catch (e: any) { setMsg(e.code === 'ALLOCATION_EXCEEDS_EXPENSE' ? 'Taqsimot xarajatdan oshib ketdi' : e.code === 'SERVICE_PERIOD_INVALID' ? 'Xizmat davri noto‘g‘ri' : e.code ?? 'ERROR'); }
  };
  return (
    <div className="an">
      <div className="spread"><h1>Reklama xarajatlari</h1><Link href="/partner/analytics" className="see-all">Hisobot →</Link></div>
      <p className="small muted">Xarajat kiritish hamyondan pul yechmaydi — faqat tahliliy natijani o‘zgartiradi. Telegram kanal adminiga to‘langan pul va Telegram Ads alohida kanal sifatida yoziladi.</p>
      {recon.length > 0 && (
        <section className="card an-sec">
          <h2>Moslashtirish kerak ({recon.length})</h2>
          <p className="small muted">Reklama kabinetidan kelgan sarf siz qo‘lda kiritgan xarajat bilan bir xil bo‘lishi mumkin. Ikkalasi qo‘shib yuborilmadi — qaysi birini qoldirishni tanlang.</p>
          {recon.map((e) => (
            <div key={e.id} className="pl-row">
              <div className="spread"><b>{e.placement_name ?? CH_LABEL[e.channel]} · {e.service_from}</b><b>{e.amount} {e.currency}</b></div>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn sm" onClick={async () => { await api(`/partner/ad-expenses/${e.id}/reconcile`, { method: 'POST', body: { keep: 'provider' } }); load(); }}>Kabinetdagisini qoldirish</button>
                <button className="btn secondary sm" onClick={async () => { await api(`/partner/ad-expenses/${e.id}/reconcile`, { method: 'POST', body: { keep: 'manual' } }); load(); }}>Qo‘lda kiritganimni qoldirish</button>
              </div>
            </div>
          ))}
        </section>
      )}
      <section className="card an-sec">
        <h2>Yangi xarajat</h2>
        {msg && <div className="notice" role="status">{msg}</div>}
        <div className="addr-grid">
          <div><label htmlFor="xk">Turi</label><select id="xk" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="actual">Haqiqiy sarf</option><option value="planned">Rejalashtirilgan byudjet (natijaga kirmaydi)</option><option value="adjustment">Tuzatish / qaytarilgan</option><option value="zero_confirmed">Bu davrda xarajat bo‘lmadi (0)</option></select></div>
          <div><label htmlFor="xc">Reklama kanali</label><select id="xc" value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>{['telegram_channel', 'telegram_ads', 'instagram_target', 'meta_mixed', 'organic', 'other'].map((c) => <option key={c} value={c}>{c === 'other' ? 'Boshqa xarajat' : CH_LABEL[c]}</option>)}</select></div>
          {f.kind !== 'zero_confirmed' && <><div><label htmlFor="xa">Summa</label><input id="xa" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(/[^\d.]/g, '') })} placeholder="250000 yoki 100.50" /></div>
            <div><label htmlFor="xcur">Valyuta</label><select id="xcur" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}><option>UZS</option><option>USD</option><option>EUR</option><option>RUB</option></select></div></>}
          <div><label htmlFor="xsf">Xizmat boshlanishi</label><input id="xsf" type="date" value={f.service_from} onChange={(e) => setF({ ...f, service_from: e.target.value })} /></div>
          <div><label htmlFor="xst">Xizmat tugashi</label><input id="xst" type="date" value={f.service_to} onChange={(e) => setF({ ...f, service_to: e.target.value })} /></div>
          <div><label htmlFor="xpa">To‘lov sanasi</label><input id="xpa" type="date" value={f.paid_at} onChange={(e) => setF({ ...f, paid_at: e.target.value })} /></div>
          <div><label htmlFor="xpy">Kim to‘ladi?</label><select id="xpy" value={f.payer} onChange={(e) => setF({ ...f, payer: e.target.value })}><option value="partner">Men (hamkor)</option><option value="shop">Do‘kon</option></select></div>
        </div>
        <label htmlFor="xpl">Joylashtirish nomi</label><input id="xpl" value={f.placement_name} maxLength={120} onChange={(e) => setF({ ...f, placement_name: e.target.value })} placeholder="Masalan: @kanal posti 12-noyabr" />
        <label htmlFor="xn">Izoh</label><input id="xn" value={f.note} maxLength={300} onChange={(e) => setF({ ...f, note: e.target.value })} />
        <h3>Qaysi havolaga tegishli?</h3>
        <p className="small muted">Bir xarajatni bir nechta havolaga bo‘lish mumkin ($100 = $60 + $40). Biriktirilmagan qismi “Taqsimlanmagan” bo‘lib ko‘rinadi va umumiy natijadan yo‘qolmaydi.</p>
        {allocs.map((a, i) => (
          <div key={i} className="row alloc-row">
            <label className="sr-only" htmlFor={`at${i}`}>Havola</label>
            <select id={`at${i}`} value={a.target} onChange={(e) => setAllocs(allocs.map((x, j) => (j === i ? { ...x, target: e.target.value } : x)))}>
              <option value="">— tanlang —</option>
              <optgroup label="Havolalar">{links.map((l: any) => <option key={l.id} value={`link:${l.id}`}>{l.name ?? l.code}</option>)}</optgroup>
              <optgroup label="Telegram/Instagram joylari">{pls.map((p: any) => <option key={p.id} value={`pl:${p.id}`}>{p.link_name} · {p.name}</option>)}</optgroup>
            </select>
            <select aria-label="Ulush turi" value={a.mode} onChange={(e) => setAllocs(allocs.map((x, j) => (j === i ? { ...x, mode: e.target.value as Alloc['mode'] } : x)))} style={{ maxWidth: 110 }}><option value="share">%</option><option value="amount">summa</option></select>
            <input aria-label="Qiymat" inputMode="decimal" value={a.value} onChange={(e) => setAllocs(allocs.map((x, j) => (j === i ? { ...x, value: e.target.value.replace(/[^\d.]/g, '') } : x)))} style={{ maxWidth: 120 }} />
            <button className="link-btn small" onClick={() => setAllocs(allocs.filter((_, j) => j !== i))}>×</button>
          </div>
        ))}
        <button className="link-btn" onClick={() => setAllocs([...allocs, { target: '', mode: 'share', value: '' }])}>+ Havolaga biriktirish</button>
        <div><button className="btn mt8" disabled={f.kind !== 'zero_confirmed' && !f.amount} onClick={submit}>Saqlash</button></div>
      </section>

      <details className="card an-sec">
        <summary><b>CSV’dan import</b></summary>
        <p className="small muted">Ustunlar: <code>date,amount,currency,channel,placement,note,external_id</code>. Bir xil external_id qayta yuklansa qo‘shilmaydi — faqat o‘zgargan summa yangilanadi.</p>
        <label htmlFor="csv" className="sr-only">CSV</label>
        <textarea id="csv" rows={4} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={'date,amount,currency,channel,placement,note,external_id\n2026-11-01,250000,UZS,telegram_channel,@kanal,,tg-1'} />
        <button className="btn secondary sm" disabled={csv.trim().length < 10} onClick={async () => { try { const r = await api('/partner/ad-expenses/import', { method: 'POST', body: { csv } }); setMsg(`Import: ${r.created} yangi, ${r.updated} yangilandi, ${r.unchanged} o‘zgarmadi${r.errors.length ? `, ${r.errors.length} xato qator` : ''}`); load(); } catch (e: any) { setMsg(e.code); } }}>Import</button>
      </details>

      <h2>Kiritilganlar</h2>
      <div className="slist">
        {items.length === 0 && <div className="empty">Hali xarajat kiritilmagan</div>}
        {items.map((e) => (
          <div key={e.id} className={`scard ${e.status !== 'active' ? 'muted-card' : ''}`}>
            <div className="spread"><b>{e.placement_name ?? (e.channel === 'other' ? 'Boshqa xarajat' : CH_LABEL[e.channel])}</b><b>{e.kind === 'zero_confirmed' ? '0 (tasdiqlangan)' : `${e.amount} ${e.currency}`}</b></div>
            <div className="small muted">{e.service_from}{e.service_to !== e.service_from ? ` — ${e.service_to}` : ''} · {({ planned: 'reja', actual: 'haqiqiy', adjustment: 'tuzatish', zero_confirmed: 'xarajat yo‘q' } as Record<string, string>)[e.kind]} · {e.payer === 'shop' ? 'do‘kon to‘lagan' : 'siz to‘lagansiz'} · {e.source === 'meta' ? 'Meta kabinetidan' : e.source === 'csv' ? 'CSV' : 'qo‘lda'}{e.currency !== 'UZS' ? (e.fx_status === 'ok' ? ` · kurs ${e.fx_rate} (${e.fx_date}, ${e.fx_source})` : ' · kurs kutilmoqda') : ''} · v{e.version}{e.status !== 'active' ? ` · ${e.status}` : ''}</div>
            {e.status === 'active' && e.source !== 'meta' && <button className="link-btn small" onClick={async () => { const reason = prompt('Bekor qilish sababi?'); if (reason && reason.length >= 3) { await api(`/partner/ad-expenses/${e.id}/void`, { method: 'POST', body: { reason } }); load(); } }}>Bekor qilish</button>}
          </div>
        ))}
      </div>
    </div>
  );
}
