'use client';
import { useCallback, useEffect, useState } from 'react';
import { Async } from '@/components/Header';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date());

export default function Admin() {
  const { lang } = useI18n();
  const [tab, setTab] = useState('summary');
  const [msg, setMsg] = useState<string | null>(null);
  const act = async (fn: () => Promise<any>, after?: () => void) => { setMsg(null); try { await fn(); setMsg('OK'); after?.(); } catch (e: any) { setMsg(e.code ?? 'ERROR'); } };
  return (
    <>
      <h1>Boshqaruv paneli</h1>
      <div className="row" role="tablist">{[['summary', 'Hisobot'], ['products', 'Mahsulotlar'], ['import', 'CSV import'], ['partners', 'Hamkorlar'], ['payouts', 'To‘lovlar (payout)'], ['finance', 'Moliya'], ['integrations', 'Integratsiyalar']].map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`btn ${tab === k ? '' : 'secondary'}`} onClick={() => setTab(k)}>{l}</button>)}</div>
      {msg && <div className="notice" role="status">{msg}</div>}
      {tab === 'summary' && <Summary />}
      {tab === 'products' && <Products act={act} lang={lang} />}
      {tab === 'import' && <Import />}
      {tab === 'partners' && <Partners act={act} />}
      {tab === 'payouts' && <Payouts act={act} />}
      {tab === 'finance' && <Finance act={act} />}
      {tab === 'integrations' && <Integrations />}
    </>
  );
}

function useLoad<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [st, setSt] = useState<{ loading: boolean; error: any }>({ loading: true, error: null });
  const load = useCallback(async () => { setSt({ loading: true, error: null }); try { setData(await api(path)); setSt({ loading: false, error: null }); } catch (e) { setSt({ loading: false, error: e }); } }, [path]);
  useEffect(() => { void load(); }, [load]);
  return { data, st, load };
}

function Summary() {
  const [range, setRange] = useState({ from: today(), to: today(), date_type: 'created' });
  const { data, st, load } = useLoad<any>(`/admin/reports/summary?from=${range.from}&to=${range.to}&date_type=${range.date_type}`);
  return (
    <section className="card" style={{ marginTop: 12 }}>
      <div className="row">
        <input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} style={{ width: 'auto' }} />
        <input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} style={{ width: 'auto' }} />
        <select value={range.date_type} onChange={(e) => setRange({ ...range, date_type: e.target.value })} style={{ width: 'auto' }}><option value="created">Yaratilgan sana</option><option value="paid">To‘langan sana</option><option value="delivered">Yetkazilgan sana</option></select>
        <a className="btn secondary" href={`/api/v1/admin/reports/orders.csv?from=${range.from}&to=${range.to}&date_type=${range.date_type}`} onClick={(e) => { e.preventDefault(); downloadCsv(range); }}>CSV</a>
      </div>
      <Async loading={st.loading} error={st.error} onRetry={load}>
        {data && (
          <>
            <p className="muted">Vaqt zonasi: {data.timezone} · sana turi: {data.date_type}</p>
            <div className="grid">
              {[['Yaratilgan buyurtmalar', data.orders_created], ['Tasdiqlangan', data.orders_confirmed], ['Yetkazilgan', data.orders_delivered], ['Yaratilgan summa (daromad emas)', som(data.created_order_total_minor)], ['To‘langan', som(data.paid_total_minor)], ['Haqiqiy sof tushum', som(data.actual_net_receipts_minor)], ['Qaytarilgan pul', som(data.refunded_minor)], ['COD kassaga tushmagan', som(data.cod_pending_minor)], ['Komissiya majburiyati (to‘lanishi kerak)', som(data.commission_obligation.payable)], ['Komissiya kutilmoqda', som(data.commission_obligation.pending)]].map(([l, v]) => <div key={String(l)} className="card"><div className="muted">{l}</div><div style={{ fontWeight: 700 }}>{v}</div></div>)}
            </div>
            <div className="notice"><strong>Taxminiy operatsion marja ({data.estimated_operating_margin.label}):</strong> {som(data.estimated_operating_margin.value_minor)} — sof foyda emas. Hisobga olinmagan: {data.estimated_operating_margin.missing.join(', ')}</div>
          </>
        )}
      </Async>
    </section>
  );
}

async function downloadCsv(range: { from: string; to: string; date_type: string }) {
  const tok = localStorage.getItem('om_token');
  const r = await fetch(`/api/v1/admin/reports/orders.csv?from=${range.from}&to=${range.to}&date_type=${range.date_type}`, { headers: { authorization: `Bearer ${tok}` } });
  const blob = await r.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `orders-${range.from}-${range.to}.csv`;
  a.click();
}

function Products({ act, lang }: { act: any; lang: any }) {
  const { data, st, load } = useLoad<any>('/admin/products');
  const cats = useLoad<any>('/categories');
  const [f, setF] = useState({ latn: '', cyrl: '', category: '', sku: '', price: '', cost: '', stock: '', ruleKind: 'percent', rule: '' });
  return (
    <section className="card" style={{ marginTop: 12 }}>
      <h2>Yangi mahsulot</h2>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div><label htmlFor="nl">Nomi (lotin)</label><input id="nl" value={f.latn} onChange={(e) => setF({ ...f, latn: e.target.value })} /></div>
        <div><label htmlFor="nc">Номи (кирилл)</label><input id="nc" value={f.cyrl} onChange={(e) => setF({ ...f, cyrl: e.target.value })} /></div>
        <div><label htmlFor="ct">Kategoriya</label><select id="ct" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="">—</option>{cats.data?.items.map((c: any) => <option key={c.id} value={c.id}>{pick(c.name, lang)}</option>)}</select></div>
        <div><label htmlFor="sk">SKU</label><input id="sk" value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value })} /></div>
        <div><label htmlFor="pr">Narx (so‘m)</label><input id="pr" inputMode="numeric" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value.replace(/\D/g, '') })} /></div>
        <div><label htmlFor="co">Tannarx (ichki)</label><input id="co" inputMode="numeric" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value.replace(/\D/g, '') })} /></div>
        <button className="btn" onClick={() => act(() => api('/admin/products', { method: 'POST', body: { name: { 'uz-Latn': f.latn, ...(f.cyrl ? { 'uz-Cyrl': f.cyrl } : {}) }, category_id: f.category, skus: [{ sku_code: f.sku, price_minor: String(BigInt(f.price || '0') * 100n), ...(f.cost ? { cost_minor: String(BigInt(f.cost) * 100n) } : {}) }] } }), load)}>Qoralama yaratish</button>
      </div>
      <Async loading={st.loading} error={st.error} onRetry={load}>
        <div className="table-wrap"><table><thead><tr><th>Mahsulot</th><th>Holat</th><th>SKU / narx / qoldiq</th><th>Komissiya</th><th>Amallar</th></tr></thead><tbody>
          {data?.items.map((p: any) => (
            <tr key={p.id}>
              <td>{pick(p.name, lang)}</td><td>{p.status}</td>
              <td>{(p.skus ?? []).map((s: any) => <div key={s.sku_id}>{s.sku_code}: {som(s.price_minor)} · {s.on_hand ?? 0} (band {s.reserved ?? 0})
                <button className="btn secondary" onClick={() => { const q = prompt('Kirim soni'); if (q) act(() => api(`/admin/skus/${s.sku_id}/stock`, { method: 'POST', body: { kind: 'receipt', qty: Number(q), reason: 'kirim', ref: crypto.randomUUID() } }), load); }}>+ kirim</button></div>)}</td>
              <td>{p.commission_rule ? (p.commission_rule.kind === 'percent' ? `${p.commission_rule.rate_bps / 100}%` : som(p.commission_rule.fixed_minor) + '/dona') : '—'}
                <label className="btn secondary" style={{ display: 'inline-flex', alignItems: 'center' }}>Rasm<input type="file" accept="image/jpeg,image/png,image/webp" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => act(() => api(`/admin/products/${p.id}/media`, { method: 'POST', body: { filename: f.name, content_base64: String(rd.result).split(',')[1], alt: { 'uz-Latn': pick(p.name, 'uz-Latn' as any) }, rights_source: 'owner upload' } }), load); rd.readAsDataURL(f); }} /></label>
                <button className="btn secondary" onClick={() => { const v = prompt('Foiz (masalan 10) yoki "f:30000" (dona uchun so‘m)'); if (!v) return; const body = v.startsWith('f:') ? { kind: 'fixed_per_unit', fixed_minor: String(BigInt(v.slice(2)) * 100n) } : { kind: 'percent', rate_bps: Math.round(Number(v) * 100) }; act(() => api(`/admin/products/${p.id}/commission-rules`, { method: 'POST', body }), load); }}>Qoida</button></td>
              <td>{p.status !== 'published' && <button className="btn" onClick={() => act(() => api(`/admin/products/${p.id}/status`, { method: 'POST', body: { status: 'published', expected_version: p.version } }), load)}>E’lon qilish</button>}
                {p.status === 'published' && <button className="btn secondary" onClick={() => act(() => api(`/admin/products/${p.id}/status`, { method: 'POST', body: { status: 'archived', expected_version: p.version } }), load)}>Arxiv</button>}</td>
            </tr>
          ))}
        </tbody></table></div>
      </Async>
    </section>
  );
}

function Partners({ act }: { act: any }) {
  const { data, st, load } = useLoad<any>('/admin/partners');
  return (
    <section className="card" style={{ marginTop: 12 }}>
      <Async loading={st.loading} error={st.error} onRetry={load}>
        <div className="table-wrap"><table><thead><tr><th>Kod</th><th>Ism</th><th>Holat</th><th>Mavjud / kutilmoqda / qarz</th><th>Rekvizit</th><th></th></tr></thead><tbody>
          {data?.items.map((p: any) => (
            <tr key={p.id}><td>{p.code}</td><td>{p.display_name}</td><td>{p.status}</td><td>{som(p.available_minor)} / {som(p.pending_minor)} / {som(p.debt_minor)}</td><td>{p.destination ?? '—'} {p.payout_destination_verified_at ? '✓' : ''}</td>
              <td className="row">{p.status !== 'active' && <button className="btn" onClick={() => act(() => api(`/admin/partners/${p.id}/status`, { method: 'POST', body: { status: 'active', reason: 'tasdiqlandi' } }), load)}>Tasdiqlash</button>}
                {p.status === 'active' && <button className="btn danger" onClick={() => { const r = prompt('Sabab'); if (r) act(() => api(`/admin/partners/${p.id}/status`, { method: 'POST', body: { status: 'suspended', reason: r } }), load); }}>To‘xtatish</button>}
                {p.destination && !p.payout_destination_verified_at && <button className="btn secondary" onClick={() => act(() => api(`/admin/partners/${p.id}/verify-destination`, { method: 'POST' }), load)}>Rekvizitni tasdiqlash</button>}</td></tr>
          ))}
        </tbody></table></div>
      </Async>
    </section>
  );
}

function Payouts({ act }: { act: any }) {
  const { data, st, load } = useLoad<any>('/admin/payouts');
  return (
    <section className="card" style={{ marginTop: 12 }}>
      <p className="muted">Tayyorlovchi va tasdiqlovchi turli shaxs bo‘lishi shart. «To‘landi» faqat bank o‘tkazmasi referensi bilan yoziladi — tugmaning o‘zi pul o‘tkazmaydi.</p>
      <Async loading={st.loading} error={st.error} onRetry={load}>
        <div className="table-wrap"><table><thead><tr><th>Hamkor</th><th>Summa</th><th>Holat</th><th>Rekvizit</th><th></th></tr></thead><tbody>
          {data?.items.map((p: any) => (
            <tr key={p.id}><td>{p.code}</td><td>{som(p.amount_minor)}</td><td>{p.status}{p.approval_mode === 'owner_only' ? ' (owner_only)' : ''}</td><td>{p.destination_snapshot?.masked}</td>
              <td className="row">
                {p.status === 'requested' && !p.prepared_by && <button className="btn secondary" onClick={() => act(() => api(`/admin/payouts/${p.id}/prepare`, { method: 'POST' }), load)}>Tayyorlash</button>}
                {p.status === 'requested' && p.prepared_by && <button className="btn" onClick={() => act(() => api(`/admin/payouts/${p.id}/approve`, { method: 'POST' }), load)}>Tasdiqlash</button>}
                {['approved', 'processing_unknown'].includes(p.status) && <>
                  <button className="btn" onClick={() => { const ref = prompt('Bank referensi'); if (ref) act(() => api(`/admin/payouts/${p.id}/result`, { method: 'POST', body: { outcome: 'paid', reference: ref } }), load); }}>To‘landi</button>
                  <button className="btn secondary" onClick={() => act(() => api(`/admin/payouts/${p.id}/result`, { method: 'POST', body: { outcome: 'processing_unknown' } }), load)}>Natija noma’lum</button>
                  <button className="btn danger" onClick={() => { const r = prompt('Sabab'); if (r) act(() => api(`/admin/payouts/${p.id}/result`, { method: 'POST', body: { outcome: 'rejected', reason: r } }), load); }}>Rad</button></>}
              </td></tr>
          ))}
        </tbody></table></div>
      </Async>
      <button className="btn secondary" onClick={() => act(() => api('/admin/commissions/release', { method: 'POST', body: {} }), load)}>Kutish muddati o‘tgan komissiyalarni ochish</button>
    </section>
  );
}

function Finance({ act }: { act: any }) {
  const rem = useLoad<any>('/finance/remittances');
  const ex = useLoad<any>('/finance/exceptions');
  return (
    <section className="card" style={{ marginTop: 12 }}>
      <h2>COD topshiriqlari</h2>
      <Async loading={rem.st.loading} error={rem.st.error} onRetry={rem.load}>
        <div className="table-wrap"><table><tbody>{rem.data?.items.map((r: any) => (
          <tr key={r.id}><td>{r.courier_name}</td><td>kutilgan {som(r.expected_minor)} · e’lon {som(r.declared_minor)}</td><td>{r.status}</td>
            <td>{r.status === 'submitted' && <button className="btn" onClick={() => { const v = prompt('Kassaga tushgan summa (so‘m)'); if (v) act(() => api(`/finance/remittances/${r.id}/confirm`, { method: 'POST', body: { received_minor: String(BigInt(v.replace(/\D/g, '')) * 100n) } }), rem.load); }}>Qabul qilish</button>}</td></tr>
        ))}</tbody></table></div>
      </Async>
      <h2>Moliyaviy istisnolar</h2>
      <Async loading={ex.st.loading} error={ex.st.error} onRetry={ex.load}>
        <div className="table-wrap"><table><tbody>{ex.data?.items.map((x: any) => (
          <tr key={x.id}><td>{x.kind}</td><td>{x.ref_type}:{x.ref_id.slice(0, 8)}</td><td>{som(x.amount_minor)}</td><td>{x.status}</td>
            <td>{x.status === 'open' && <button className="btn secondary" onClick={() => { const r = prompt('Yechim (kamida 10 belgi, dalil bilan)'); if (r) act(() => api(`/finance/exceptions/${x.id}/resolve`, { method: 'POST', body: { resolution: r } }), ex.load); }}>Yopish</button>}</td></tr>
        ))}</tbody></table></div>
      </Async>
    </section>
  );
}

function Integrations() {
  const { data, st, load } = useLoad<any>('/admin/integrations');
  return (
    <section className="card" style={{ marginTop: 12 }}>
      <Async loading={st.loading} error={st.error} onRetry={load}>
        <table><tbody>{data?.items.map((i: any) => <tr key={i.key}><td>{i.key}</td><td><span className="badge test">{i.mode}</span></td><td>{i.live_verified ? 'live ✓' : 'live tekshirilmagan'}</td><td className="muted">{i.note}</td></tr>)}</tbody></table>
      </Async>
    </section>
  );
}

function Import() {
  const [csv, setCsv] = useState('sku_code,product_slug,name_uz_latn,name_uz_cyrl,category_slug,price_som,cost_som,stock_receipt,brand,variant\n');
  const [pv, setPv] = useState<any>(null);
  const [res, setRes] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <section className="card" style={{ marginTop: 12 }}>
      <p className="muted">Avval tekshiruv (hech narsa yozilmaydi), keyin tasdiqlash. Qayta import SKU dublikatini yaratmaydi.</p>
      {err && <div className="notice" role="alert">{err}</div>}
      <label htmlFor="csv">CSV</label>
      <textarea id="csv" rows={8} value={csv} onChange={(e) => { setCsv(e.target.value); setPv(null); }} />
      <input type="file" accept=".csv,text/csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) f.text().then((t) => { setCsv(t); setPv(null); }); }} />
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn secondary" onClick={async () => { setErr(null); setRes(null); try { setPv(await api('/admin/imports/products/preview', { method: 'POST', body: { csv } })); } catch (e: any) { setErr(e.code); } }}>Tekshirish</button>
        {pv && pv.valid_rows > 0 && <button className="btn" onClick={async () => { try { setRes(await api(`/admin/imports/${pv.batch_id}/commit`, { method: 'POST' })); } catch (e: any) { setErr(e.code); } }}>Tasdiqlash ({pv.valid_rows} qator)</button>}
      </div>
      {pv && (
        <div style={{ marginTop: 8 }}>
          <p>Jami {pv.total_rows} · to‘g‘ri {pv.valid_rows} · xato {pv.rejected_rows} · o‘zgarishlar: {Object.entries(pv.changes).map(([k, v]) => `${k}: ${v}`).join(', ') || '—'} · qabul qilinadigan qoldiq: {pv.stock_units_to_receive}</p>
          {pv.errors.length > 0 && <table><thead><tr><th>Qator</th><th>Maydon</th><th>Xato</th></tr></thead><tbody>{pv.errors.map((e: any, i: number) => <tr key={i}><td>{e.line}</td><td>{e.field}</td><td>{e.code}</td></tr>)}</tbody></table>}
        </div>
      )}
      {res && <div className="notice ok" role="status">Yozildi: {res.committed_rows} qator {res.replayed ? '(avval yozilgan)' : ''}</div>}
    </section>
  );
}
