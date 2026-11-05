'use client';
import { useCallback, useEffect, useState } from 'react';
import { Async } from '@/components/Header';
import { api, getToken, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';
import { AdminOrderList } from './AdminOrderList';
import { ContestCenterAdmin } from './ContestCenter';
import { QualityCenterAdmin } from './QualityCenter';
import { CharityCenterAdmin } from './CharityCenter';
import { UzcoinAdmin } from './UzcoinAdmin';
import { LandingsAdmin } from './LandingsAdmin';
import { TargetAdmin } from './TargetAdmin';
import { LevelsAdmin } from './LevelsAdmin';
import { FinanceAdmin } from './FinanceAdmin';
import { Decisions } from './Decisions';
import { ProductEditor } from './ProductEditor';
import { AdminPrograms } from './Programs';
import { errText, stText } from '@/lib/errors';
import { Staff } from './Staff';
import { StockAlerts } from './StockAlerts';

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date());

export default function Admin() {
  const { lang } = useI18n();
  const [tab, setTab] = useState('orders');
  useEffect(() => { try { const q = new URLSearchParams(location.search).get('tab'); if (q) setTab(q); } catch {} }, []);
  const [newProduct, setNewProduct] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);
  const act = async (fn: () => Promise<any>, after?: () => void) => { setMsg(null); try { await fn(); setMsg('OK'); after?.(); } catch (e: any) { setMsg(errText(e)); } };
  return (
    <>
      <div className="spread admin-head">
        <h1>Boshqaruv paneli</h1>
        <button className="btn" onClick={() => { setTab('products'); setNewProduct((n) => n + 1); }}>+ Mahsulot qo‘shish</button>
      </div>
      <div className="admin-tabs" role="tablist">{[['decisions', '🚨', 'Muammolar'], ['orders', '📦', 'Buyurtmalar'], ['products', '🛍️', 'Mahsulotlar'], ['partners', '🤝', 'Hamkorlar'], ['flow', '🏷️', 'Qabul qilingan tovarlar'], ['stock', '📉', 'Ombor ogohlantirishi'], ['contests', '🏆', 'Konkurs markazi'], ['quality', '🛡️', 'Sifat markazi'], ['charity', '💝', 'Xayriya markazi'], ['uzcoin', '🪙', 'UzCoin'], ['levels', '🎖️', 'Darajalar'], ['landings', '🧩', 'Landinglar'], ['target', '🎯', 'Target'], ['programs', '🎁', 'Bonus va jarimalar'], ['summary', '📊', 'Hisobot'], ['payouts', '💳', 'Pul yechish so‘rovlari'], ['finance', '💰', 'Moliya'], ['promos', '🎟️', 'Promokodlar'], ['import', '📄', 'CSV import'], ['staff', '👥', 'Xodimlar'], ['integrations', '⚙️', 'Integratsiyalar']].map(([k, i, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`admin-tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k!)}><span aria-hidden>{i}</span>{l}</button>)}<a className="admin-tab" href="/admin/commission"><span aria-hidden>🧮</span>Komissiya matritsasi va kurs</a></div>
      {msg && <div className="notice" role="status">{msg}</div>}
      {tab === 'decisions' && <Decisions go={setTab} />}
      {tab === 'orders' && <Orders lang={lang} />}
      {tab === 'flow' && <Flow lang={lang} />}
      {tab === 'programs' && <AdminPrograms />}
      {tab === 'contests' && <ContestCenterAdmin />}
      {tab === 'quality' && <QualityCenterAdmin />}
      {tab === 'charity' && <CharityCenterAdmin />}
      {tab === 'uzcoin' && <UzcoinAdmin />}
      {tab === 'levels' && <LevelsAdmin />}
      {tab === 'landings' && <LandingsAdmin />}
      {tab === 'target' && <TargetAdmin />}
      {tab === 'summary' && <Summary />}
      {tab === 'products' && <Products act={act} lang={lang} openNew={newProduct} />}
      {tab === 'import' && <Import />}
      {tab === 'promos' && <Promos act={act} />}
      {tab === 'partners' && <Partners act={act} />}
      {tab === 'payouts' && <Payouts act={act} />}
      {tab === 'finance' && <FinanceAdmin />}
      {tab === 'staff' && <Staff />}
      {tab === 'stock' && <StockAlerts />}
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

function Products({ act, lang, openNew = 0 }: { act: any; lang: any; openNew?: number }) {
  const { data, st, load } = useLoad<any>('/admin/products');
  const cats = useLoad<any>('/categories');
  const [editor, setEditor] = useState<{ product?: any } | null>(null);
  useEffect(() => { if (openNew > 0) setEditor({}); }, [openNew]);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('all');
  const all: any[] = data?.items ?? [];
  const items = all.filter((p) => (status === 'all' || p.status === status) && (!q || pick(p.name, lang).toLowerCase().includes(q.toLowerCase()) || (p.skus ?? []).some((s: any) => s.sku_code.toLowerCase().includes(q.toLowerCase()))));
  const count = (k: string) => all.filter((p) => p.status === k).length;
  return (
    <section style={{ marginTop: 12 }}>
      <div className="spread"><h2>Mahsulotlar <span className="muted">{data ? `${all.length} ta` : ''}</span></h2><button className="btn" onClick={() => setEditor({})}>+ Yangi mahsulot</button></div>
      <div className="chips" role="group" aria-label="Holat" style={{ marginTop: 8 }}>
        {[['all', `Barchasi (${all.length})`], ['published', `Sotuvda (${count('published')})`], ['draft', `Qoralama (${count('draft')})`], ['archived', `Arxiv (${count('archived')})`]].map(([k, l]) => <button key={k} type="button" className={`chip ${status === k ? 'on' : ''}`} aria-pressed={status === k} onClick={() => setStatus(k!)}>{l}</button>)}
      </div>
      <form className="search plain" role="search" onSubmit={(e) => e.preventDefault()}>
        <label htmlFor="pq-admin" className="sr-only">Mahsulot qidirish</label>
        <input id="pq-admin" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nomi yoki artikul…" />
      </form>
      <Async loading={st.loading} error={st.error} onRetry={load}>
        {items.length === 0 && <div className="empty"><p>Mahsulot yo‘q</p><button className="btn" onClick={() => setEditor({})}>+ Birinchi mahsulotni qo‘shish</button></div>}
        <div className="slist">
          {items.map((p: any) => {
            const stock = (p.skus ?? []).reduce((a: number, s: any) => a + (s.on_hand ?? 0) - (s.reserved ?? 0), 0);
            const prices = (p.skus ?? []).map((s: any) => BigInt(s.price_minor ?? '0'));
            const min = prices.length ? prices.reduce((a: bigint, b: bigint) => (b < a ? b : a)) : 0n;
            return (
              <article key={p.id} className="scard prod-card">
                <div className="prod-top">
                  {p.image ? <img src={p.image} alt="" width={72} height={72} /> : <div className="ph sm" aria-hidden />}
                  <div className="prod-info">
                    <div className="spread"><h3>{pick(p.name, lang)}</h3><span className={`pill ${p.status === 'published' ? 'b-delivered' : p.status === 'archived' ? 'b-cancelled' : 'b-shipping'}`}>{STATUS_UZ[p.status] ?? p.status}</span></div>
                    <div className="small"><b>{som(min.toString())}</b>{(p.skus ?? []).length > 1 ? ` dan · ${(p.skus ?? []).length} variant` : ''}</div>
                    <div className="muted small">Mavjud: <b className={stock > 5 ? 'ok-t' : 'no-t'}>{stock} dona</b> · Komissiya: <b>{p.commission_rule ? (p.commission_rule.kind === 'percent' ? `${p.commission_rule.rate_bps / 100}%` : som(p.commission_rule.fixed_minor) + '/dona') : 'yo‘q'}</b></div>
                  </div>
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <button className="btn sm" onClick={() => setEditor({ product: p })}>✏️ Tahrirlash</button>
                  {p.status !== 'published' && <button className="btn secondary sm" onClick={() => act(() => api(`/admin/products/${p.id}/status`, { method: 'POST', body: { status: 'published', expected_version: p.version } }), load)}>E’lon qilish</button>}
                  {p.status === 'published' && <button className="btn secondary sm" onClick={() => { if (confirm('Mahsulot sotuvdan olinsinmi (arxiv)?')) act(() => api(`/admin/products/${p.id}/status`, { method: 'POST', body: { status: 'archived', expected_version: p.version } }), load); }}>Sotuvdan olish</button>}
                  <a className="btn secondary sm" href={`/p/${p.slug}`} target="_blank" rel="noopener noreferrer">Ko‘rish</a>
                </div>
                <details className="prod-more">
                  <summary>Rasmlar va videolar</summary>
                  <ProductMedia productId={p.id} />
                  <ProductVideos productId={p.id} />
                </details>
              </article>
            );
          })}
        </div>
      </Async>
      {editor && <ProductEditor product={editor.product} categories={cats.data?.items ?? []} lang={lang} onClose={() => setEditor(null)} onSaved={load} />}
    </section>
  );
}

const BUCKET_UZ: Record<string, string> = { new: 'Yangi', accepted: 'Qabul qilindi', shipping: 'Yetkazilmoqda', delivered: 'Yetkazildi', returned: 'Qaytdi', cancelled: 'Bekor qilingan' };
const PERIODS_UZ: [string, string][] = [['today', 'Bugun'], ['yesterday', 'Kecha'], ['week', 'Hafta'], ['month', 'Shu oy'], ['all', 'Hammasi']];

function Orders({ lang: _lang }: { lang: any }) {
  const [period, setPeriod] = useState('all');
  return (
    <section style={{ marginTop: 12 }}>
      <div className="chips" role="group" aria-label="Davr">{PERIODS_UZ.map(([k, l]) => <button key={k} type="button" className={`chip ${period === k ? 'on' : ''}`} aria-pressed={period === k} onClick={() => setPeriod(k)}>{l}</button>)}</div>
      <AdminOrderList period={period} />
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
              <Sellers productId={p.id} period={period} />
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

const PSTATUS_UZ: Record<string, string> = { active: 'Faol', pending: 'Ariza', suspended: 'To‘xtatilgan', rejected: 'Rad etilgan' };

function Partners({ act }: { act: any }) {
  const { lang } = useI18n();
  const [period, setPeriod] = useState('month');
  const [q, setQ] = useState('');
  const { data, st, load } = useLoad<any>(`/admin/partners/performance?period=${period}${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  const items: any[] = data?.items ?? [];
  const sum = items.reduce((a, p) => ({ partners: a.partners + (p.status === 'active' ? 1 : 0), clicks: a.clicks + p.clicks, orders: a.orders + p.orders.total, delivered: a.delivered + p.orders.delivered, sales: a.sales + BigInt(p.delivered_sales_minor) }), { partners: 0, clicks: 0, orders: 0, delivered: 0, sales: 0n });
  const pending = items.filter((p) => p.status === 'pending');
  const medal = (r: number) => (r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : `#${r}`);
  return (
    <section style={{ marginTop: 12 }}>
      <h2>Kim sotyapti?</h2>
      <div className="chips" role="group" aria-label="Davr">{PERIODS_UZ.map(([k, l]) => <button key={k} type="button" className={`chip ${period === k ? 'on' : ''}`} aria-pressed={period === k} onClick={() => setPeriod(k)}>{l}</button>)}</div>
      <div className="kpi-row">
        <div className="card kpi"><span className="muted">Faol hamkorlar</span><b>{sum.partners}</b></div>
        <div className="card kpi"><span className="muted">Bosishlar</span><b>{sum.clicks}</b></div>
        <div className="card kpi"><span className="muted">Buyurtmalar</span><b>{sum.orders}</b></div>
        <div className="card kpi"><span className="muted">Yetkazilgan</span><b>{sum.delivered}</b></div>
        <div className="card kpi"><span className="muted">Hamkorlar orqali savdo</span><b>{som(sum.sales.toString())}</b></div>
      </div>
      {pending.length > 0 && <p className="notice">🆕 {pending.length} ta yangi hamkorlik arizasi tasdiqlashni kutmoqda.</p>}
      <form className="search plain" role="search" style={{ marginTop: 10 }} onSubmit={(e) => e.preventDefault()}>
        <label htmlFor="hq" className="sr-only">Hamkor qidirish</label>
        <input id="hq" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ism yoki hamkor kodi…" />
      </form>
      <Async loading={st.loading} error={st.error} onRetry={load}>
        {items.length === 0 && <div className="empty">Hali hamkor yo‘q</div>}
        <div className="slist">
          {items.map((p) => (
            <article key={p.id} className="scard">
              <div className="spread">
                <div className="row" style={{ gap: 10 }}>
                  <span className="top-rank">{medal(p.rank)}</span>
                  <div><h3><a href={`/admin/partner/${p.id}`} className="w-link">{p.display_name} ›</a></h3><div className="muted small"><code>{p.code}</code> · {p.streams} ta oqim · {new Date(p.created_at).toLocaleDateString('uz-UZ')} dan</div></div>
                </div>
                <span className={`pill ${p.status === 'active' ? 'b-delivered' : p.status === 'pending' ? 'b-shipping' : 'b-returned'}`}>{PSTATUS_UZ[p.status] ?? p.status}</span>
              </div>
              <div className="flow-grid">
                <div><span>Bosishlar</span><b>{p.clicks}</b></div>
                <div><span>Buyurtma</span><b>{p.orders.total}</b></div>
                <div><span>Yetkazildi</span><b className="ok-t">{p.orders.delivered}</b></div>
                <div><span>Yetkazish %</span><b>{p.delivery_rate_pct === null ? '—' : `${p.delivery_rate_pct}%`}</b></div>
                <div className="hl"><span>Savdo (yetkazilgan)</span><b style={{ fontSize: 16 }}>{som(p.delivered_sales_minor)}</b></div>
                <div><span>Komissiya</span><b style={{ fontSize: 16 }}>{som(p.commission_earned_minor)}</b></div>
              </div>
              <div className="pills">
                {(['new', 'accepted', 'shipping', 'delivered', 'returned', 'cancelled'] as const).map((k) => <a key={k} href={`/admin/partner/${p.id}?status=${k}`} className={`pill pill-link b-${k}`}>{BUCKET_UZ[k]}: {p.orders[k]} ›</a>)}
              </div>
              {p.top_products?.length > 0 && <div className="small"><b>Ko‘p sotadi:</b> {p.top_products.map((t: any) => `${pick(t.name, lang)} (${t.orders})`).join(', ')}</div>}
              <div className="muted small">Balans: yechish mumkin {som(p.available_minor)} · kutilmoqda {som(p.pending_minor)} · to‘langan {som(p.paid_minor)}{p.debt_minor && p.debt_minor !== '0' ? ` · qarz ${som(p.debt_minor)}` : ''} · karta: {p.destination ?? '—'} {p.payout_destination_verified_at ? '✓' : ''}</div>
              <div className="row" style={{ gap: 8 }}>
                <a className="btn sm" href={`/admin/partner/${p.id}`}>👁 Kuzatish</a>
                {p.status !== 'active' && <button className="btn sm" onClick={() => act(() => api(`/admin/partners/${p.id}/status`, { method: 'POST', body: { status: 'active', reason: 'tasdiqlandi' } }), load)}>Tasdiqlash</button>}
                {p.status === 'active' && <button className="btn danger sm" onClick={() => { const r = prompt('Sabab'); if (r) act(() => api(`/admin/partners/${p.id}/status`, { method: 'POST', body: { status: 'suspended', reason: r } }), load); }}>To‘xtatish</button>}
                {p.destination && !p.payout_destination_verified_at && <button className="btn secondary sm" onClick={() => act(() => api(`/admin/partners/${p.id}/verify-destination`, { method: 'POST' }), load)}>Kartani tasdiqlash</button>}
              </div>
            </article>
          ))}
        </div>
      </Async>
    </section>
  );
}

function Sellers({ productId, period }: { productId: string; period: string }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (rows === null) return <button type="button" className="btn secondary sm" onClick={() => api(`/admin/products/${productId}/sellers?period=${period}`).then((r) => setRows(r.items)).catch((e) => setErr(errText(e)))}>🤝 Kim sotyapti?{err ? ` (${err})` : ''}</button>;
  if (rows.length === 0) return <p className="muted small">Bu mahsulotni hali hech bir hamkor sotmagan.</p>;
  return (
    <div className="seller-list">
      {rows.map((r) => (
        <div key={r.id} className="seller-row">
          <div><b>{r.display_name}</b> <span className="muted small">{r.code}</span></div>
          <div className="pills">
            <span className="pill">👆 {r.clicks}</span>
            <span className="pill b-new">🛒 {r.orders} buyurtma ({r.qty} dona)</span>
            <span className="pill b-delivered">✅ {r.delivered_qty} dona yetkazildi</span>
            <span className="pill b-accepted">💰 {som(r.commission_minor)}</span>
          </div>
        </div>
      ))}
    </div>
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
            <tr key={p.id}><td>{p.code}</td><td>{som(p.amount_minor)}</td><td>{stText(p.status)}{p.approval_mode === 'owner_only' ? ` (${stText('owner_only')})` : ''}</td><td>{p.destination_snapshot?.masked}</td>
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

function Integrations() {
  const { data, st, load } = useLoad<any>('/admin/integrations');
  const flags = useLoad<any>('/admin/feature-flags');
  const [msg, setMsg] = useState<string | null>(null);
  const ai = flags.data?.items.find((f: any) => f.key === 'ai.enabled');
  return (
    <section className="card" style={{ marginTop: 12 }}>
      {msg && <div className="notice" role="status">{msg}</div>}
      {ai && <div className="row" style={{ marginBottom: 12 }}><strong>AI yordamchi:</strong> {ai.enabled ? 'yoqilgan' : 'o‘chiq'}
        <button className="btn secondary" onClick={async () => { const r = prompt('Sabab'); if (!r) return; try { await api('/admin/feature-flags/ai.enabled', { method: 'POST', body: { enabled: !ai.enabled, reason: r } }); setMsg('OK'); flags.load(); } catch (e: any) { setMsg(errText(e)); } }}>{ai.enabled ? 'O‘chirish (kill switch)' : 'Yoqish'}</button></div>}
      <Async loading={st.loading} error={st.error} onRetry={load}>
        <div className="table-wrap"><table><tbody>{data?.items.map((i: any) => <tr key={i.key}><td>{i.key}</td><td><span className="badge test">{i.mode}</span></td><td>{i.live_verified ? 'live ✓' : 'live tekshirilmagan'}</td><td className="muted">{i.note}</td></tr>)}</tbody></table></div>
      </Async>
    </section>
  );
}

const FIELD_UZ: Record<string, string> = { sku_code: 'SKU (artikul)', product_slug: 'Mahsulot slug', name_uz_latn: 'Nomi', name_uz_cyrl: 'Nomi (kirill)', category_slug: 'Toifa', price_som: 'Narx', cost_som: 'Tannarx', stock_receipt: 'Qoldiq', brand: 'Brend', variant: 'Variant' };
const CODE_UZ: Record<string, string> = { required: 'to‘ldirilmagan', invalid: 'noto‘g‘ri qiymat', unknown: 'bunday toifa yo‘q (pastdagi ro‘yxatdan oling)', duplicate_in_file: 'faylda ikki marta yozilgan', variant_exists: 'bu mahsulotda shu variant allaqachon bor (boshqa SKU bilan) — SKU ni o‘zgartirmang, mavjudini yangilang', variant_duplicate_in_file: 'shu mahsulotning shu varianti faylda ikki marta' };

function Import() {
  const { lang } = useI18n();
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [pv, setPv] = useState<any>(null);
  const [res, setRes] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [cats, setCats] = useState<any[]>([]);
  useEffect(() => { api('/categories').then((c) => setCats(c.items ?? [])).catch(() => {}); }, []);
  const sample = () => {
    const cat = cats[0]?.slug ?? 'elektronika';
    const rows = [
      'SKU;Nomi;Toifa;Narx;Qoldiq;Brend;Tannarx;variant',
      `QUL-001-QORA;Namuna quloqchin A1;${cat};246 000;10;Navro‘z;180 000;rang=qora`,
      `QUL-001-OQ;Namuna quloqchin A1;${cat};246 000;5;Navro‘z;180 000;rang=oq`,
    ];
    const blob = new Blob(['﻿' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'uzshop-mahsulotlar-namuna.csv'; a.click(); URL.revokeObjectURL(a.href);
  };
  return (
    <section className="card import-box" style={{ marginTop: 12 }}>
      <h2>Mahsulotlarni Excel/CSV orqali yuklash</h2>
      <ol className="small import-steps">
        <li><button type="button" className="link-btn small" onClick={sample}>⬇ Namuna faylni yuklab oling</button> va Excel’da oching.</li>
        <li>Har bir qator — bitta SKU (masalan, bitta o‘lcham yoki rang). Majburiy ustunlar: <b>SKU, Nomi, Toifa, Narx</b>.</li>
        <li>Narxni so‘mda yozing: <code>246 000</code> yoki <code>246000</code> bo‘laveradi.</li>
        <li>Excel’da <b>«CSV (разделители — точка с запятой)»</b> yoki <b>«CSV UTF-8»</b> qilib saqlang va shu yerga yuklang.</li>
      </ol>
      {err && <div className="notice" role="alert">{err}</div>}
      <label className="btn secondary file-btn">📄 Faylni tanlash<input type="file" accept=".csv,text/csv" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) { setFileName(f.name); f.text().then((t) => { setCsv(t); setPv(null); setRes(null); }); } e.target.value = ''; }} /></label>
      {fileName && <span className="small muted"> {fileName}</span>}
      <details className="task-more"><summary>Yoki matnni shu yerga qo‘ying</summary>
        <textarea id="csv" aria-label="CSV matni" rows={6} value={csv} onChange={(e) => { setCsv(e.target.value); setPv(null); }} />
      </details>
      <div className="row" style={{ marginTop: 8, gap: 8 }}>
        <button className="btn secondary" disabled={csv.trim().length < 10} onClick={async () => { setErr(null); setRes(null); try { setPv(await api('/admin/imports/products/preview', { method: 'POST', body: { csv } })); } catch (e: any) { setErr(e.code === 'CSV_HEADER_INVALID' ? `Faylda majburiy ustun yo‘q: ${Object.keys(e.field_errors ?? {}).map((k) => FIELD_UZ[k] ?? k).join(', ')}` : errText(e)); } }}>1. Tekshirish</button>
        {pv && pv.valid_rows > 0 && <button className="btn" onClick={async () => { try { setRes(await api(`/admin/imports/${pv.batch_id}/commit`, { method: 'POST' })); setPv(null); } catch (e: any) { setErr(errText(e)); } }}>2. Yuklash ({pv.valid_rows} qator)</button>}
      </div>
      <p className="muted small">Tekshirishda hech narsa yozilmaydi. Qayta yuklash dublikat yaratmaydi — SKU bo‘yicha yangilaydi.</p>
      {pv && (
        <div className="import-res">
          <div className="desk-stats"><span><b>{pv.total_rows}</b> qator</span><span><b>{pv.valid_rows}</b> to‘g‘ri</span>{pv.rejected_rows > 0 && <span className="bad"><b>{pv.rejected_rows}</b> xato</span>}{pv.stock_units_to_receive > 0 && <span><b>{pv.stock_units_to_receive}</b> dona omborga</span>}</div>
          {pv.errors.length > 0 && <div className="table-wrap"><table><thead><tr><th>Qator</th><th>Ustun</th><th>Muammo</th></tr></thead><tbody>{pv.errors.map((e: any, i: number) => <tr key={i}><td>{e.line}</td><td>{FIELD_UZ[e.field] ?? e.field}</td><td>{CODE_UZ[e.code] ?? e.code}</td></tr>)}</tbody></table></div>}
          {pv.rejected_rows > 0 && pv.valid_rows > 0 && <p className="small">Xato qatorlar yuklanmaydi. Ularni tuzatib, faylni qayta yuklashingiz mumkin.</p>}
        </div>
      )}
      {res && <div className="notice ok" role="status">✓ Yuklandi: {res.committed_rows} qator {res.replayed ? '(avval yuklangan)' : ''}</div>}
      <details className="task-more"><summary>Toifalar ro‘yxati («Toifa» ustuniga shu kodlardan birini yozing)</summary>
        <div className="table-wrap"><table><tbody>{cats.map((c) => <tr key={c.id}><td><code>{c.slug}</code></td><td>{pick(c.name, lang)}</td></tr>)}</tbody></table></div>
      </details>
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
        <div className="table-wrap"><table><tbody>{data?.items.map((p: any) => <tr key={p.id}><td><code>{p.code}</code></td><td>{stText(p.kind)} {p.value_bps ? p.value_bps / 100 + '%' : som(p.value_minor)}</td><td>{new Date(p.starts_at).toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent' })} → {new Date(p.ends_at).toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent' })}</td><td>{p.redemptions_reserved}/{p.max_redemptions ?? '∞'}</td><td>{stText(p.status)}</td>
          <td>{p.status === 'active' && <button className="btn secondary" onClick={() => act(() => api(`/admin/promotions/${p.id}/pause`, { method: 'POST' }), load)}>To‘xtatish</button>}</td></tr>)}</tbody></table></div>
      </Async>
    </section>
  );
}

function ProductMedia({ productId }: { productId: string }) {
  const [items, setItems] = useState<any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => api(`/admin/products/${productId}/media`).then((r) => setItems(r.items)).catch((e) => setErr(errText(e)));
  if (items === null) return <button className="btn secondary" onClick={load}>Rasmlar</button>;
  return (
    <div className="media-admin">
      {items.length === 0 && <span className="muted small">Rasm yo‘q</span>}
      {items.map((m) => (
        <div key={m.id} className="media-thumb">
          <img src={m.url} alt="" width={64} height={64} />
          <button className="btn danger sm" aria-label="Rasmni o‘chirish" onClick={async () => { if (!confirm('Rasm do‘kondan olib tashlansinmi?')) return; try { await api(`/admin/media/${m.id}`, { method: 'DELETE' }); await load(); } catch (e: any) { setErr(errText(e)); } }}>×</button>
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
  const load = () => api(`/admin/products/${productId}/videos`).then((r) => setItems(r.items)).catch((e) => setMsg(errText(e)));
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
    } catch (e: any) { setMsg(e.code === 'VIDEO_TYPE_NOT_ALLOWED' ? 'Faqat MP4 video (telefon kamerasi videosi) qabul qilinadi.' : errText(e)); } finally { setBusy(false); }
  };
  if (items === null) return <button className="btn secondary" onClick={load}>Videolar</button>;
  return (
    <div className="media-admin">
      {items.length === 0 && <span className="muted small">Video yo‘q</span>}
      {items.map((v) => (
        <div key={v.id} className="media-thumb">
          <video src={v.url} poster={v.poster ?? undefined} width={64} height={96} muted playsInline preload="metadata" style={{ width: 64, height: 96, objectFit: 'cover', borderRadius: 10, display: 'block' }} />
          <button className="btn danger sm" aria-label="Videoni o‘chirish" onClick={async () => { if (!confirm('Video olib tashlansinmi?')) return; try { await api(`/admin/videos/${v.id}`, { method: 'DELETE' }); await load(); } catch (e: any) { setMsg(errText(e)); } }}>×</button>
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
