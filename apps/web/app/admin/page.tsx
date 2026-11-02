'use client';
import { useCallback, useEffect, useState } from 'react';
import { Async } from '@/components/Header';
import { api, getToken, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date());

export default function Admin() {
  const { lang } = useI18n();
  const [tab, setTab] = useState('orders');
  const [msg, setMsg] = useState<string | null>(null);
  const act = async (fn: () => Promise<any>, after?: () => void) => { setMsg(null); try { await fn(); setMsg('OK'); after?.(); } catch (e: any) { setMsg(e.code ?? 'ERROR'); } };
  return (
    <>
      <h1>Boshqaruv paneli</h1>
      <div className="chips admin-tabs" role="tablist">{[['orders', '📦 Buyurtmalar'], ['flow', '🏷️ Qabul qilingan tovarlar'], ['summary', '📊 Hisobot'], ['products', 'Mahsulotlar'], ['import', 'CSV import'], ['promos', 'Promokodlar'], ['partners', 'Hamkorlar'], ['payouts', 'To‘lovlar (payout)'], ['finance', 'Moliya'], ['integrations', 'Integratsiyalar']].map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`chip ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{l}</button>)}</div>
      {msg && <div className="notice" role="status">{msg}</div>}
      {tab === 'orders' && <Orders lang={lang} />}
      {tab === 'flow' && <Flow lang={lang} />}
      {tab === 'summary' && <Summary />}
      {tab === 'products' && <Products act={act} lang={lang} />}
      {tab === 'import' && <Import />}
      {tab === 'promos' && <Promos act={act} />}
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
  const r = await fetch(`/api/v1/admin/reports/orders.csv?from=${range.from}&to=${range.to}&date_type=${range.date_type}`, { headers: { 'x-session-token': tok ?? '' } });
  const blob = await r.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `orders-${range.from}-${range.to}.csv`;
  a.click();
}

const STATUS_UZ: Record<string, string> = { published: 'Sotuvda', draft: 'Qoralama', archived: 'Arxiv', pending_review: 'Tekshiruvda' };

function Products({ act, lang }: { act: any; lang: any }) {
  const { data, st, load } = useLoad<any>('/admin/products');
  const cats = useLoad<any>('/categories');
  const [f, setF] = useState({ latn: '', cyrl: '', category: '', sku: '', price: '', cost: '', stock: '', ruleKind: 'percent', rule: '' });
  const [showNew, setShowNew] = useState(false);
  const [q, setQ] = useState('');
  const items = (data?.items ?? []).filter((p: any) => !q || pick(p.name, lang).toLowerCase().includes(q.toLowerCase()) || (p.skus ?? []).some((s: any) => s.sku_code.toLowerCase().includes(q.toLowerCase())));
  return (
    <section style={{ marginTop: 12 }}>
      <div className="spread"><h2>Mahsulotlar <span className="muted">{data ? `${data.items.length} ta` : ''}</span></h2><button className="btn" onClick={() => setShowNew(!showNew)}>{showNew ? 'Yopish' : '+ Yangi mahsulot'}</button></div>
      {showNew && (
        <div className="card" style={{ marginTop: 10 }}>
          <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
            <div><label htmlFor="nl">Nomi (lotin)</label><input id="nl" value={f.latn} onChange={(e) => setF({ ...f, latn: e.target.value })} /></div>
            <div><label htmlFor="nc">Номи (кирилл)</label><input id="nc" value={f.cyrl} onChange={(e) => setF({ ...f, cyrl: e.target.value })} /></div>
            <div><label htmlFor="ct">Kategoriya</label><select id="ct" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="">—</option>{cats.data?.items.map((c: any) => <option key={c.id} value={c.id}>{pick(c.name, lang)}</option>)}</select></div>
            <div><label htmlFor="sk">SKU (artikul)</label><input id="sk" value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value })} /></div>
            <div><label htmlFor="pr">Narx (so‘m)</label><input id="pr" inputMode="numeric" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value.replace(/\D/g, '') })} /></div>
            <div><label htmlFor="co">Tannarx (ichki)</label><input id="co" inputMode="numeric" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value.replace(/\D/g, '') })} /></div>
          </div>
          <p className="muted small">Qoralama yaratilgach: kirim (qoldiq), rasm, komissiya qoidasini qo‘shing va «E’lon qilish»ni bosing.</p>
          <button className="btn" onClick={() => act(() => api('/admin/products', { method: 'POST', body: { name: { 'uz-Latn': f.latn, ...(f.cyrl ? { 'uz-Cyrl': f.cyrl } : {}) }, category_id: f.category, skus: [{ sku_code: f.sku, price_minor: String(BigInt(f.price || '0') * 100n), ...(f.cost ? { cost_minor: String(BigInt(f.cost) * 100n) } : {}) }] } }), () => { setShowNew(false); void load(); })}>Qoralama yaratish</button>
        </div>
      )}
      <form className="search plain" role="search" style={{ marginTop: 10 }} onSubmit={(e) => e.preventDefault()}>
        <label htmlFor="pq-admin" className="sr-only">Mahsulot qidirish</label>
        <input id="pq-admin" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nomi yoki SKU…" />
      </form>
      <Async loading={st.loading} error={st.error} onRetry={load}>
        <div className="slist">
          {items.map((p: any) => {
            const stock = (p.skus ?? []).reduce((a: number, s: any) => a + (s.on_hand ?? 0) - (s.reserved ?? 0), 0);
            return (
              <article key={p.id} className="scard">
                <div className="spread">
                  <h3>{pick(p.name, lang)}</h3>
                  <span className={`pill ${p.status === 'published' ? 'b-delivered' : p.status === 'archived' ? 'b-cancelled' : 'b-shipping'}`}>{STATUS_UZ[p.status] ?? p.status}</span>
                </div>
                <div className="muted small">Mavjud: <b className={stock > 5 ? 'ok-t' : 'no-t'}>{stock} dona</b> · Komissiya: <b>{p.commission_rule ? (p.commission_rule.kind === 'percent' ? `${p.commission_rule.rate_bps / 100}%` : som(p.commission_rule.fixed_minor) + '/dona') : 'yo‘q'}</b></div>
                <div className="sku-list">
                  {(p.skus ?? []).map((s: any) => (
                    <div key={s.sku_id} className="sku-row">
                      <div><b>{Object.values(s.variant ?? {}).join(' / ') || s.sku_code}</b> <span className="muted small">{s.sku_code}</span></div>
                      <div>{som(s.price_minor)}</div>
                      <div className="small">Omborda {s.on_hand ?? 0} · band {s.reserved ?? 0}</div>
                      <button className="btn secondary sm" onClick={() => { const qn = prompt('Nechta kirim qilinadi?'); if (qn) act(() => api(`/admin/skus/${s.sku_id}/stock`, { method: 'POST', body: { kind: 'receipt', qty: Number(qn), reason: 'kirim', ref: crypto.randomUUID() } }), load); }}>+ Kirim</button>
                    </div>
                  ))}
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <label className="btn secondary sm" style={{ display: 'inline-flex', alignItems: 'center' }}>+ Rasm<input type="file" accept="image/jpeg,image/png,image/webp" style={{ display: 'none' }} onChange={(e) => { const fl = e.target.files?.[0]; if (!fl) return; const rd = new FileReader(); rd.onload = () => act(() => api(`/admin/products/${p.id}/media`, { method: 'POST', body: { filename: fl.name, content_base64: String(rd.result).split(',')[1], alt: { 'uz-Latn': pick(p.name, 'uz-Latn' as any) }, rights_source: 'owner upload' } }), load); rd.readAsDataURL(fl); }} /></label>
                  <button className="btn secondary sm" onClick={() => { const v = prompt('Komissiya: foiz (masalan 10) yoki "f:30000" (dona uchun so‘m)'); if (!v) return; const body = v.startsWith('f:') ? { kind: 'fixed_per_unit', fixed_minor: String(BigInt(v.slice(2)) * 100n) } : { kind: 'percent', rate_bps: Math.round(Number(v) * 100) }; act(() => api(`/admin/products/${p.id}/commission-rules`, { method: 'POST', body }), load); }}>Komissiya</button>
                  {p.status !== 'published' && <button className="btn sm" onClick={() => act(() => api(`/admin/products/${p.id}/status`, { method: 'POST', body: { status: 'published', expected_version: p.version } }), load)}>E’lon qilish</button>}
                  {p.status === 'published' && <button className="btn secondary sm" onClick={() => act(() => api(`/admin/products/${p.id}/status`, { method: 'POST', body: { status: 'archived', expected_version: p.version } }), load)}>Arxivga</button>}
                  <a className="btn secondary sm" href={`/p/${p.slug}`} target="_blank" rel="noopener noreferrer">Ko‘rish</a>
                </div>
                <ProductMedia productId={p.id} />
                <ProductVideos productId={p.id} />
              </article>
            );
          })}
        </div>
      </Async>
    </section>
  );
}

const BUCKET_UZ: Record<string, string> = { new: 'Yangi', accepted: 'Qabul qilindi', shipping: 'Yetkazilmoqda', delivered: 'Yetkazildi', returned: 'Qaytdi', cancelled: 'Bekor qilingan' };
const BUCKET_KEYS = ['new', 'accepted', 'shipping', 'delivered', 'returned', 'cancelled'];
const PERIODS_UZ: [string, string][] = [['today', 'Bugun'], ['yesterday', 'Kecha'], ['week', 'Hafta'], ['month', 'Shu oy'], ['all', 'Hammasi']];

function Orders({ lang }: { lang: any }) {
  const [status, setStatus] = useState('all');
  const [period, setPeriod] = useState('all');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const qs = new URLSearchParams({ status, period, ...(query ? { q: query } : {}) });
  const { data, st, load } = useLoad<any>(`/admin/orders?${qs}`);
  const c = data?.counts ?? {};
  return (
    <section style={{ marginTop: 12 }}>
      <form className="search plain" role="search" onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); }}>
        <label htmlFor="oq" className="sr-only">Buyurtma qidirish</label>
        <input id="oq" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Raqam, telefon, ism yoki mahsulot…" />
        <button className="search-btn" aria-label="Izlash">Izlash</button>
      </form>
      <div className="chips" role="group" aria-label="Davr">{PERIODS_UZ.map(([k, l]) => <button key={k} type="button" className={`chip ${period === k ? 'on' : ''}`} aria-pressed={period === k} onClick={() => setPeriod(k)}>{l}</button>)}</div>
      <div className="stat-grid" style={{ marginBottom: 10 }}>
        <button type="button" className={`stat s-total ${status === 'all' ? 'sel' : ''}`} onClick={() => setStatus('all')}><b>{c.total ?? 0}</b><span>Barchasi</span></button>
        {BUCKET_KEYS.map((b) => <button type="button" key={b} className={`stat s-${b} ${status === b ? 'sel' : ''}`} onClick={() => setStatus(b)}><b>{c[b] ?? 0}</b><span>{BUCKET_UZ[b]}</span></button>)}
      </div>
      <Async loading={st.loading} error={st.error} onRetry={load}>
        {data?.items.length === 0 && <div className="empty">Buyurtma topilmadi</div>}
        <div className="slist">
          {data?.items.map((o: any) => {
            const a = o.address_snapshot ?? {};
            const quick = a.quick && a.house === '-';
            return (
              <article key={o.id} className="scard">
                <div className="spread">
                  <b>{o.number}</b>
                  <span className={`pill b-${o.bucket}`}>{BUCKET_UZ[o.bucket]}</span>
                </div>
                <div className="req-grid">
                  <div><span>Mijoz</span>{o.customer_name ?? '—'} · <a href={`tel:${o.customer_phone}`}>{o.customer_phone}</a></div>
                  <div><span>Summa</span><b>{som(o.payable_minor)}</b> <span className="muted small">{o.payment_method === 'cod' ? 'naqd' : 'onlayn'}</span></div>
                  <div><span>Manzil</span>{quick ? <span className="no-t">⚡ Tez buyurtma — manzil so‘ralmagan</span> : [a.district, a.street, a.house].filter(Boolean).join(', ')}</div>
                  <div><span>Hamkor</span>{o.partner_code ? `${o.partner_name} (${o.partner_code})${o.stream_name ? ` · ${o.stream_name}` : ''}` : '—'}</div>
                </div>
                <div className="small">{(o.items ?? []).map((i: any, k: number) => <div key={k}>• {pick(i.name, lang)}{i.variant && Object.values(i.variant).length ? ` (${Object.values(i.variant).join('/')})` : ''} × <b>{i.qty}</b></div>)}</div>
                <div className="spread muted small">
                  <span>🕒 {new Date(o.created_at).toLocaleString('uz-UZ', { dateStyle: 'short', timeStyle: 'short' })}{o.operator_name ? ` · operator: ${o.operator_name}` : ''}</span>
                  <a href={`/ops?order=${o.id}`}>Kartochka →</a>
                </div>
              </article>
            );
          })}
        </div>
      </Async>
    </section>
  );
}

function Flow({ lang }: { lang: any }) {
  const [period, setPeriod] = useState('month');
  const [q, setQ] = useState('');
  const { data, st, load } = useLoad<any>(`/admin/products/flow?period=${period}${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  return (
    <section style={{ marginTop: 12 }}>
      <h2>Qabul qilingan tovarlar</h2>
      <p className="muted small">Har bir mahsulot bo‘yicha: omborda qancha, buyurtmalarda qancha band, qanchasi jo‘natishga tayyor, yo‘lda va yetkazilgan.</p>
      <form className="search plain" role="search" onSubmit={(e) => e.preventDefault()}>
        <label htmlFor="fq" className="sr-only">Mahsulot qidirish</label>
        <input id="fq" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Mahsulot nomi…" />
      </form>
      <div className="chips" role="group" aria-label="Davr">{PERIODS_UZ.map(([k, l]) => <button key={k} type="button" className={`chip ${period === k ? 'on' : ''}`} aria-pressed={period === k} onClick={() => setPeriod(k)}>{l}</button>)}</div>
      <Async loading={st.loading} error={st.error} onRetry={load}>
        {data?.items.length === 0 && <div className="empty">Hozircha mahsulot yo‘q</div>}
        <div className="slist">
          {data?.items.map((p: any) => (
            <article key={p.id} className="scard flow-card">
              <div className="scard-top" style={{ gridTemplateColumns: '64px 1fr' }}>
                {p.image ? <img src={p.image} alt="" width={64} height={64} /> : <div className="ph sm" aria-hidden />}
                <div><h3>{pick(p.name, lang)}</h3><div className="muted small">{STATUS_UZ[p.status] ?? p.status} · {p.total_orders} ta buyurtma</div></div>
              </div>
              <div className="flow-grid">
                <div><span>Omborda</span><b>{p.on_hand}</b></div>
                <div><span>Band (rezerv)</span><b>{p.reserved}</b></div>
                <div><span>Sotish mumkin</span><b className={p.available > 5 ? 'ok-t' : 'no-t'}>{p.available}</b></div>
                <div className="hl"><span>Jo‘natishga tayyor</span><b>{p.accepted_to_ship}</b></div>
                <div><span>Yo‘lda</span><b>{p.in_delivery}</b></div>
                <div><span>Yetkazilgan</span><b className="ok-t">{p.delivered}</b></div>
              </div>
              <div className="pills">
                <span className="pill b-new">Yangi (tasdiq kutmoqda): {p.ordered.new}</span>
                <span className="pill b-returned">Qaytgan: {p.ordered.returned}</span>
                <span className="pill b-cancelled">Bekor: {p.ordered.cancelled}</span>
              </div>
            </article>
          ))}
        </div>
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
  const flags = useLoad<any>('/admin/feature-flags');
  const [msg, setMsg] = useState<string | null>(null);
  const ai = flags.data?.items.find((f: any) => f.key === 'ai.enabled');
  return (
    <section className="card" style={{ marginTop: 12 }}>
      {msg && <div className="notice" role="status">{msg}</div>}
      {ai && <div className="row" style={{ marginBottom: 12 }}><strong>AI yordamchi:</strong> {ai.enabled ? 'yoqilgan' : 'o‘chiq'}
        <button className="btn secondary" onClick={async () => { const r = prompt('Sabab'); if (!r) return; try { await api('/admin/feature-flags/ai.enabled', { method: 'POST', body: { enabled: !ai.enabled, reason: r } }); setMsg('OK'); flags.load(); } catch (e: any) { setMsg(e.code); } }}>{ai.enabled ? 'O‘chirish (kill switch)' : 'Yoqish'}</button></div>}
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

function Promos({ act }: { act: any }) {
  const { data, st, load } = useLoad<any>('/admin/promotions');
  const [f, setF] = useState({ code: '', percent: '', from: '', to: '', max: '' });
  return (
    <section className="card" style={{ marginTop: 12 }}>
      <p className="muted">Vaqtlar Asia/Tashkent (+05:00) bo‘yicha kiritiladi; limit tranzaksion tekshiriladi.</p>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div><label htmlFor="pc">Kod</label><input id="pc" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></div>
        <div><label htmlFor="pp">Chegirma %</label><input id="pp" inputMode="numeric" value={f.percent} onChange={(e) => setF({ ...f, percent: e.target.value.replace(/\D/g, '') })} /></div>
        <div><label htmlFor="pf">Boshlanish</label><input id="pf" type="datetime-local" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></div>
        <div><label htmlFor="pt">Tugash</label><input id="pt" type="datetime-local" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></div>
        <div><label htmlFor="pm">Limit</label><input id="pm" inputMode="numeric" value={f.max} onChange={(e) => setF({ ...f, max: e.target.value.replace(/\D/g, '') })} /></div>
        <button className="btn" onClick={() => act(() => api('/admin/promotions', { method: 'POST', body: { code: f.code, name: { 'uz-Latn': f.code }, kind: 'cart_percent', value_bps: Number(f.percent) * 100, starts_at: `${f.from}:00+05:00`, ends_at: `${f.to}:00+05:00`, ...(f.max ? { max_redemptions: Number(f.max) } : {}) } }), load)}>Yaratish</button>
      </div>
      <Async loading={st.loading} error={st.error} onRetry={load}>
        <table><tbody>{data?.items.map((p: any) => <tr key={p.id}><td><code>{p.code}</code></td><td>{p.kind} {p.value_bps ? p.value_bps / 100 + '%' : som(p.value_minor)}</td><td>{new Date(p.starts_at).toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent' })} → {new Date(p.ends_at).toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent' })}</td><td>{p.redemptions_reserved}/{p.max_redemptions ?? '∞'}</td><td>{p.status}</td>
          <td>{p.status === 'active' && <button className="btn secondary" onClick={() => act(() => api(`/admin/promotions/${p.id}/pause`, { method: 'POST' }), load)}>To‘xtatish</button>}</td></tr>)}</tbody></table>
      </Async>
    </section>
  );
}

function ProductMedia({ productId }: { productId: string }) {
  const [items, setItems] = useState<any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => api(`/admin/products/${productId}/media`).then((r) => setItems(r.items)).catch((e) => setErr(e.code));
  if (items === null) return <button className="btn secondary" onClick={load}>Rasmlar</button>;
  return (
    <div className="media-admin">
      {items.length === 0 && <span className="muted small">Rasm yo‘q</span>}
      {items.map((m) => (
        <div key={m.id} className="media-thumb">
          <img src={m.url} alt="" width={64} height={64} />
          <button className="btn danger sm" aria-label="Rasmni o‘chirish" onClick={async () => { if (!confirm('Rasm do‘kondan olib tashlansinmi?')) return; try { await api(`/admin/media/${m.id}`, { method: 'DELETE' }); await load(); } catch (e: any) { setErr(e.code); } }}>×</button>
        </div>
      ))}
      {err && <span className="field-error">{err}</span>}
    </div>
  );
}

function ProductVideos({ productId }: { productId: string }) {
  const [items, setItems] = useState<any[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api(`/admin/products/${productId}/videos`).then((r) => setItems(r.items)).catch((e) => setMsg(e.code));
  const upload = async (f: File) => {
    if (f.size > 40 * 1024 * 1024) { setMsg('Video 40 MB dan katta. Qisqaroq (15–60 soniya) video yuklang.'); return; }
    const caption = prompt('Video izohi (ixtiyoriy)') ?? '';
    setBusy(true); setMsg('Yuklanmoqda…');
    try {
      const headers: Record<string, string> = { 'content-type': 'video/mp4' };
      const tok = getToken(); if (tok) headers['x-session-token'] = tok;
      const r = await fetch(`/api/v1/admin/products/${productId}/videos${caption ? `?caption=${encodeURIComponent(caption)}` : ''}`, { method: 'POST', headers, body: f });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw j;
      setMsg('Video yuklandi ✓'); await load();
    } catch (e: any) { setMsg(e.code === 'VIDEO_TYPE_NOT_ALLOWED' ? 'Faqat MP4 video (telefon kamerasi videosi) qabul qilinadi.' : e.code ?? 'ERROR'); } finally { setBusy(false); }
  };
  if (items === null) return <button className="btn secondary" onClick={load}>Videolar</button>;
  return (
    <div className="media-admin">
      {items.length === 0 && <span className="muted small">Video yo‘q</span>}
      {items.map((v) => (
        <div key={v.id} className="media-thumb">
          <video src={v.url} poster={v.poster ?? undefined} width={64} height={96} muted playsInline preload="metadata" style={{ width: 64, height: 96, objectFit: 'cover', borderRadius: 10, display: 'block' }} />
          <button className="btn danger sm" aria-label="Videoni o‘chirish" onClick={async () => { if (!confirm('Video olib tashlansinmi?')) return; try { await api(`/admin/videos/${v.id}`, { method: 'DELETE' }); await load(); } catch (e: any) { setMsg(e.code); } }}>×</button>
          <span className="muted small">❤ {v.likes} · 👁 {v.views}</span>
        </div>
      ))}
      <label className={`btn secondary sm ${busy ? 'disabled' : ''}`} style={{ display: 'inline-flex', alignItems: 'center' }}>+ Video (MP4)
        <input type="file" accept="video/mp4" style={{ display: 'none' }} disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
      </label>
      {msg && <span className="small" role="status">{msg}</span>}
    </div>
  );
}
