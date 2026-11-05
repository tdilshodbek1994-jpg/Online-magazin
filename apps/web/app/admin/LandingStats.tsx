'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, som } from '@/lib/api';
import { errText } from '@/lib/errors';
import { toast } from '@/lib/toast';

const CH: Record<string, string> = { meta_mixed: 'Meta (aralash)', instagram_target: 'Instagram target', telegram_ads: 'Telegram Ads', telegram_channel: 'Telegram kanal', organic: 'Organik', other: 'Boshqa' };
const pc = (v: number | null) => (v === null ? '—' : `${v}%`);
const today = () => new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);

/** Landing tahlili (P1A): tashrif, buyurtma va dona, voronka, klik konversiyasi, do‘kon reklama xarajati (kiritilmagan ≠ 0). */
export function LandingStats({ id }: { id: string }) {
  const [from, setFrom] = useState(`${today().slice(0, 8)}01`);
  const [to, setTo] = useState(today());
  const [r, setR] = useState<any>(null);
  const [f, setF] = useState({ amount: '', currency: 'UZS', channel: 'meta_mixed', service_from: today(), service_to: today(), note: '' });
  const [split, setSplit] = useState<Record<string, string>>({});
  const load = useCallback(() => { api(`/admin/landings/${id}/analytics?from=${from}&to=${to}`).then(setR).catch((e) => toast(errText(e), 'err')); }, [id, from, to]);
  useEffect(load, [load]);
  if (!r) return null;
  const c = r.counts, m = r.money;
  const save = async () => {
    const allocations = Object.entries(split).filter(([, v]) => Number(v) > 0).map(([k, v]) => ({ root_link_id: k, share_bps: Math.round(Number(v) * 100) }));
    try {
      const x = await api(`/admin/landings/${id}/spend`, { method: 'POST', body: { ...f, kind: Number(f.amount) === 0 ? 'zero_confirmed' : 'actual', note: f.note || undefined, ...(allocations.length ? { allocations } : {}) } });
      toast(x.outcome === 'needs_reconcile' ? 'Bu xarajat boshqa yozuv bilan solishtirishga tushdi' : '✓ Xarajat yozildi (hamyondan pul yechilmaydi)');
      setF({ ...f, amount: '', note: '' }); load();
    } catch (e: any) { toast(e.code === 'ALLOCATION_EXCEEDS_EXPENSE' ? 'Ulushlar 100% dan oshmasin.' : errText(e), 'err'); }
  };
  const tiles: [string, string][] = [
    ['Tashrif (havola)', String(c.visits)], ['Buyurtma', `${c.orders} (havola ${c.link_orders} · hamkor kiritgan ${c.on_behalf_orders})`],
    ['Yetkazildi', `${c.delivered} buyurtma · ${c.delivered_units} dona`], ['Tasdiqlash', pc(r.ratios.approval)], ['Yetkazish (tasdiqlangandan)', pc(r.ratios.delivery_from_confirmed)],
    ['Klikdan buyurtma', pc(r.ratios.click_conversion)], ['Do‘kon reklama xarajati', m.shop_ad_spend === null ? 'kiritilmagan' : som(m.shop_ad_spend)],
    ['Yetkazilgan buyurtma narxi', m.cost_per_delivered_order === null ? '—' : som(m.cost_per_delivered_order)], ['Yetkazilgan savdo', som(m.delivered_gross)],
    ['Komissiya (kutilmoqda / tayyor)', `${som(m.commission_waiting)} / ${som(m.commission_available)}`],
  ];
  return (
    <details className="card pp-more" style={{ marginTop: 10 }}>
      <summary>📊 Tahlil va reklama xarajati</summary>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <label className="small">Dan <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="small">Gacha <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <div className="tr-grid">{tiles.map(([k, v]) => <div key={k} className="tile"><b style={{ fontSize: 16 }}>{v}</b><span className="small muted">{k}</span></div>)}</div>
      {r.completeness.notes.map((n: string) => <p key={n} className="notice small">{n}</p>)}
      {r.flows.length > 0 && <table className="tr-table"><tbody><tr><th>Oqim</th><th>Tashrif</th><th>Buyurtma</th><th>Xarajat ulushi</th></tr>{r.flows.map((x: any) => <tr key={x.id}><td>{x.name ?? x.code} · {x.partner}</td><td>{x.visits}</td><td>{x.orders}</td><td>{x.shop_spend_allocated === null ? '—' : som(x.shop_spend_allocated)}</td></tr>)}</tbody></table>}
      {r.spend_rows.length > 0 && <table className="tr-table" style={{ marginTop: 8 }}><tbody>{r.spend_rows.map((x: any) => <tr key={x.id}><td>{x.service_from}{x.service_to !== x.service_from ? ` — ${x.service_to}` : ''}</td><td>{CH[x.channel] ?? x.channel}</td><td>{x.currency === 'UZS' ? som(x.amount_uzs_minor) : `${x.amount_original} ${x.currency}${x.amount_uzs_minor ? ` = ${som(x.amount_uzs_minor)} (kurs ${x.fx_date})` : ' (kurs kutilmoqda)'}`}</td><td className="muted">{x.status === 'needs_reconcile' ? 'solishtirish kerak' : x.kind === 'zero_confirmed' ? 'xarajat yo‘q (tasdiqlangan)' : 'do‘kon to‘lagan'}</td></tr>)}</tbody></table>}
      <h3 className="small" style={{ marginTop: 12 }}>Do‘kon to‘lagan reklama xarajatini yozish</h3>
      <p className="small muted">Bu faqat hisobot uchun: hamkor hamyonidan pul yechilmaydi, hamkorning shaxsiy xarajatiga yozilmaydi. Xarajat yo‘q bo‘lsa 0 kiriting — «kiritilmagan» bilan «0» farq qiladi.</p>
      <div className="tr-form">
        <div className="row" style={{ gap: 8 }}>
          <input aria-label="Summa" inputMode="decimal" placeholder="Summa" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(/[^\d.]/g, '') })} />
          <select aria-label="Valyuta" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}><option>UZS</option><option>USD</option></select>
        </div>
        <select aria-label="Kanal" value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>{Object.entries(CH).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <div className="row" style={{ gap: 8 }}><input type="date" aria-label="Boshlanish" value={f.service_from} onChange={(e) => setF({ ...f, service_from: e.target.value })} /><input type="date" aria-label="Tugash" value={f.service_to} onChange={(e) => setF({ ...f, service_to: e.target.value })} /></div>
        {r.flows.length > 0 && <div className="small">Oqimlarga bo‘lish (%, ixtiyoriy):{r.flows.map((x: any) => <label key={x.id} className="row" style={{ gap: 6, alignItems: 'center' }}><span style={{ flex: 1 }}>{x.name ?? x.code}</span><input style={{ width: 80 }} inputMode="decimal" value={split[x.id] ?? ''} onChange={(e) => setSplit({ ...split, [x.id]: e.target.value.replace(/[^\d.]/g, '') })} /></label>)}</div>}
        <input aria-label="Izoh" placeholder="Izoh (ixtiyoriy)" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value.slice(0, 300) })} />
        <button className="btn sm" disabled={f.amount === ''} onClick={save}>{Number(f.amount) === 0 && f.amount !== '' ? 'Xarajat yo‘qligini tasdiqlash' : 'Xarajatni yozish'}</button>
      </div>
    </details>
  );
}
