'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';

/**
 * Admin: versioned quantity-matrix commission (spec §5). Percentages apply to the BASE partner commission, not the price:
 * 2 units with 2nd unit 25% = 30 000 + 7 500. Publishing creates a new version from now on; existing orders keep their snapshot.
 */
export default function CommissionAdmin() {
  const { lang } = useI18n();
  const [q, setQ] = useState('');
  const [products, setProducts] = useState<any[]>([]);
  const [sel, setSel] = useState<string[]>([]);
  const [base, setBase] = useState('30000');
  const [m, setM] = useState({ '1': ['100'], '2': ['100', '25'], '3': ['100', '50', '25'] } as Record<string, string[]>);
  const [group, setGroup] = useState('');
  const [note, setNote] = useState('');
  const [pv, setPv] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [review, setReview] = useState<any[]>([]);
  const [fx, setFx] = useState({ currency: 'USD', date: new Date().toISOString().slice(0, 10), rate: '', nominal: '1' });
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  useEffect(() => { api('/admin/commission-review').then((r) => setReview(r.items)).catch(() => {}); }, []);
  useEffect(() => { const h = setTimeout(() => api(`/admin/products?q=${encodeURIComponent(q)}`).then((r) => setProducts((r.items ?? []).slice(0, 30))).catch(() => {}), 250); return () => clearTimeout(h); }, [q]);
  const matrix = () => Object.fromEntries(Object.entries(m).filter(([, v]) => v.every((x) => x !== '')).map(([k, v]) => [k, v.map((x) => Math.round(Number(x) * 100))]));
  const baseMinor = () => String(BigInt(base.replace(/\D/g, '') || '0') * 100n);
  useEffect(() => { if (!/^\d+$/.test(base) || base === '0') return; api('/admin/commission-rules/preview', { method: 'POST', body: { base_minor: baseMinor(), matrix: matrix() } }).then(setPv).catch(() => setPv(null)); }, [base, m]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="an">
      <Link href="/admin" className="see-all">← Boshqaruv paneli</Link>
      <h1>Komissiya: miqdor matritsasi</h1>
      <p className="small muted">Foiz mahsulot narxiga emas, hamkorning bazaviy komissiyasiga qo‘llanadi. Matritsa bitta buyurtma ichidagi bir guruh donalari uchun ishlaydi (oylik sotuv tartibi uchun emas). Belgilanmagan miqdor (masalan 4+) uchun stavka o‘ylab topilmaydi — buyurtma ko‘rib chiqishga tushadi.</p>
      <section className="card an-sec">
        <h2>Yangi qoida versiyasi</h2>
        {msg && <div className="notice" role="status">{msg}</div>}
        <label htmlFor="cq">Mahsulotlar</label>
        <input id="cq" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Mahsulot nomi…" />
        <div className="offer-pick">{products.map((p) => <button key={p.id} type="button" className={`chip ${sel.includes(p.id) ? 'on' : ''}`} aria-pressed={sel.includes(p.id)} onClick={() => setSel(sel.includes(p.id) ? sel.filter((x) => x !== p.id) : [...sel, p.id])}>{pick(p.name, lang)}</button>)}</div>
        <div className="addr-grid">
          <div><label htmlFor="cb">Bazaviy komissiya (so‘m)</label><input id="cb" inputMode="numeric" value={base} onChange={(e) => setBase(e.target.value.replace(/\D/g, ''))} /></div>
          <div><label htmlFor="cg">Komissiya guruhi (ixtiyoriy)</label><input id="cg" value={group} onChange={(e) => setGroup(e.target.value)} placeholder="Variantlar bir guruhda" /></div>
        </div>
        <table className="mx"><thead><tr><th>Miqdor</th><th>1-dona %</th><th>2-dona %</th><th>3-dona %</th><th>Jami</th></tr></thead>
          <tbody>{(['1', '2', '3'] as const).map((k) => (
            <tr key={k}><th>{k} dona</th>{[0, 1, 2].map((i) => <td key={i}>{i < Number(k) ? <input aria-label={`${k} dona, ${i + 1}-dona %`} inputMode="decimal" value={m[k]![i] ?? ''} onChange={(e) => setM({ ...m, [k]: m[k]!.map((x, j) => (j === i ? e.target.value.replace(/[^\d.]/g, '') : x)) })} /> : '—'}</td>)}
              <td><b>{pv?.preview?.[Number(k) - 1]?.total_minor ? som(pv.preview[Number(k) - 1].total_minor) : '—'}</b></td></tr>
          ))}<tr><th>4+ dona</th><td colSpan={3} className="small muted">Qoida yo‘q — ko‘rib chiqishga tushadi</td><td>—</td></tr></tbody></table>
        <label htmlFor="cn">Izoh (majburiy)</label><input id="cn" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Masalan: noyabr aksiyasi" />
        <button className="btn mt8" disabled={!sel.length || note.trim().length < 3} onClick={async () => {
          setMsg(null);
          try { const r = await api('/admin/commission-rules/matrix', { method: 'POST', body: { product_ids: sel, base_minor: baseMinor(), matrix: matrix(), note: note.trim(), ...(group ? { commission_group: group } : {}) } }); setMsg(`Nashr qilindi: ${r.published.length} ta mahsulot, ${new Date(r.effective_from).toLocaleString('uz-UZ')} dan. Eski buyurtmalar o‘zgarmaydi.`); setSel([]); }
          catch (e: any) { setMsg(e.code === 'STEP_UP_REQUIRED' ? 'MFA tasdig‘i kerak' : e.code ?? 'ERROR'); }
        }}>Nashr qilish</button>
        <p className="small muted">Qoida faqat “commission.quantity_matrix” funksiyasi yoqilganda kuchga kiradi (Integratsiyalar bo‘limidagi bayroqlar).</p>
      </section>

      <section className="card an-sec">
        <h2>Ko‘rib chiqish navbati ({review.length})</h2>
        {review.length === 0 ? <p className="muted small">Navbat bo‘sh</p> : review.map((r) => <div key={r.id} className="sum-row"><span>{r.number} · {r.group_qty} dona</span><span className="small muted">{r.review_reason}</span></div>)}
      </section>

      <section className="card an-sec">
        <h2>Valyuta kursi</h2>
        <p className="small muted">Rasmiy kurs Markaziy bankdan olinadi (amount_uzs = summa × Rate / Nominal). Kurs topilmasa xarajat “kurs kutilmoqda” holatida qoladi — 1 deb olinmaydi.</p>
        <button className="btn secondary sm" onClick={async () => { try { const r = await api('/admin/fx/sync-cbu', { method: 'POST', body: {} }); setMsg(`CBU: ${r.rates} ta kurs, ${r.repriced} ta xarajat narxlandi`); } catch (e: any) { setMsg(e.code === 'FX_SOURCE_UNAVAILABLE' ? 'CBU manbasiga ulanib bo‘lmadi — qo‘lda kiriting' : e.code); } }}>CBU’dan bugungi kurslarni olish</button>
        <div className="addr-grid">
          <div><label htmlFor="fc">Valyuta</label><input id="fc" value={fx.currency} maxLength={3} onChange={(e) => setFx({ ...fx, currency: e.target.value.toUpperCase() })} /></div>
          <div><label htmlFor="fd">Sana</label><input id="fd" type="date" value={fx.date} onChange={(e) => setFx({ ...fx, date: e.target.value })} /></div>
          <div><label htmlFor="fr">Rate</label><input id="fr" inputMode="decimal" value={fx.rate} onChange={(e) => setFx({ ...fx, rate: e.target.value.replace(/[^\d.]/g, '') })} /></div>
          <div><label htmlFor="fn">Nominal</label><input id="fn" inputMode="numeric" value={fx.nominal} onChange={(e) => setFx({ ...fx, nominal: e.target.value.replace(/\D/g, '') })} /></div>
        </div>
        <button className="btn secondary sm mt8" disabled={!fx.rate} onClick={async () => { const r = await api('/admin/fx', { method: 'POST', body: { currency: fx.currency, date: fx.date, rate: fx.rate, nominal: Number(fx.nominal || 1) } }).catch((e) => ({ error: e.code })); setMsg(r.error ? r.error : `Saqlandi; ${r.repriced} ta kutilayotgan xarajat narxlandi`); }}>Kursni saqlash</button>
      </section>

      <section className="card an-sec">
        <h2>Oyni yopish</h2>
        <p className="small muted">Har hamkor uchun versiyalangan snapshot saqlanadi. Qayta yopish yangi “qayta hisoblangan” versiya qo‘shadi — eskisi almashtirilmaydi.</p>
        <div className="row" style={{ gap: 8 }}><label className="sr-only" htmlFor="mm">Oy</label><input id="mm" type="month" value={month} onChange={(e) => setMonth(e.target.value)} style={{ maxWidth: 200 }} />
          <button className="btn secondary sm" onClick={async () => { const r = await api('/admin/reports/close-month', { method: 'POST', body: { month } }).catch((e) => ({ error: e.code })); setMsg(r.error ?? `${r.snapshots} ta snapshot saqlandi`); }}>Yopish</button></div>
      </section>
    </div>
  );
}
