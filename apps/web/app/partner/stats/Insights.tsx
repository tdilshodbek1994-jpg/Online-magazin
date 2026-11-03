'use client';
import { useEffect, useState } from 'react';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';
import { Chips } from '../shared';
import { errText } from '@/lib/errors';

/** "Raqam emas, qarorga yordam" (V2 §17): separated channels, honest rates with formula and n, net after ad spend, where sales stop. */
export function Insights() {
  const { lang } = useI18n();
  const [days, setDays] = useState('30');
  const [d, setD] = useState<any>(null);
  const [spend, setSpend] = useState<any[]>([]);
  const [form, setForm] = useState({ spent_on: new Date().toISOString().slice(0, 10), amount: '', channel: '' });
  const [err, setErr] = useState<string | null>(null);
  const load = () => { api(`/partner/insights?days=${days}`).then(setD).catch((e) => setErr(errText(e))); api('/partner/ad-spend').then((r) => setSpend(r.items)).catch(() => {}); };
  useEffect(load, [days]); // eslint-disable-line react-hooks/exhaustive-deps
  const Rate = ({ label, r }: { label: string; r: any }) => (
    <div className="card kpi rate" title={r.formula}>
      <span className="muted">{label}</span>
      <b>{r.value === null ? 'Ma’lumot yo‘q' : `${r.value}%`}</b>
      <small className="muted">{r.den > 0 ? `${r.num} / ${r.den}` : 'Bo‘luvchi 0'}{r.small_sample ? ' · namuna kichik' : ''}</small>
      <details><summary className="small">Qanday hisoblanadi?</summary><p className="small muted">{r.formula}</p></details>
    </div>
  );
  return (
    <section className="insights" aria-labelledby="ins-h">
      <h2 id="ins-h">Qayerda to‘xtab qolyapti?</h2>
      <Chips items={[['7', '7 kun'], ['30', '30 kun'], ['90', '90 kun']]} value={days} onChange={setDays} label="Davr" />
      {err && <div className="notice" role="alert">{err}</div>}
      {d && (
        <>
          <div className="stuck-list">
            {d.stuck.map((s: any, i: number) => <div key={i} className="att-item"><b>{s.title}</b><small>{s.detail} <span className="muted">(n = {s.n})</span></small></div>)}
          </div>
          <div className="kpi-row">
            <div className="card kpi"><span className="muted">Havola bosishlari</span><b>{d.counts.clicks}</b><small className="muted">{d.counts.visitors} noyob tashrifchi</small></div>
            <div className="card kpi"><span className="muted">Veb-buyurtmalar</span><b>{d.counts.web_orders}</b><small className="muted">havola orqali</small></div>
            <div className="card kpi"><span className="muted">Siz kiritgan</span><b>{d.counts.manual_orders}</b><small className="muted">konversiyaga qo‘shilmaydi</small></div>
            <div className="card kpi"><span className="muted">Yakunlanmagan</span><b>{d.counts.open}</b><small className="muted">foizlar hali o‘zgaradi</small></div>
          </div>
          <div className="kpi-row">
            <Rate label="Veb konversiya" r={d.rates.web_conversion} />
            <Rate label="Tasdiqlanish" r={d.rates.acceptance} />
            <Rate label="Yetkazish (shu davr buyurtmalari)" r={d.rates.delivery_cohort} />
            <div className="card kpi"><span className="muted">Shu davrda yetkazilgan</span><b>{d.counts.delivered_in_period}</b><small className="muted">qachon yaratilganidan qat’i nazar</small></div>
          </div>
          <div className="card money-box">
            <div className="sum-row"><span>Tasdiqlangan komissiya</span><b>{som(d.money.confirmed_minor)}</b></div>
            <div className="sum-row"><span>Kutilayotgan komissiya</span><b>{som(d.money.expected_minor)}</b></div>
            <div className="sum-row"><span>Reklama xarajati <small className="muted">({d.money.ad_spend_source})</small></span><b>{d.money.ad_spend_entries ? `− ${som(d.money.ad_spend_minor)}` : '—'}</b></div>
            <div className="sum-row total"><span>{d.money.net_minor === null ? 'Komissiya' : 'Sof natija'}</span><b className={d.money.net_minor !== null && d.money.net_minor.startsWith('-') ? 'no-t' : 'ok-t'}>{som(d.money.net_minor ?? d.money.confirmed_minor)}</b></div>
            <p className="small muted">{d.money.net_label}</p>
          </div>
          <details className="card">
            <summary><b>Reklama xarajatini kiritish</b></summary>
            <div className="addr-grid">
              <div><label htmlFor="sd">Sana</label><input id="sd" type="date" value={form.spent_on} onChange={(e) => setForm({ ...form, spent_on: e.target.value })} /></div>
              <div><label htmlFor="sa">Summa (so‘m)</label><input id="sa" inputMode="numeric" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value.replace(/\D/g, '') })} /></div>
              <div><label htmlFor="sc">Kanal</label><input id="sc" value={form.channel} maxLength={60} onChange={(e) => setForm({ ...form, channel: e.target.value })} placeholder="Instagram, Telegram…" /></div>
            </div>
            <button className="btn secondary sm mt8" disabled={!form.amount || form.amount === '0'} onClick={async () => { await api('/partner/ad-spend', { method: 'POST', body: { spent_on: form.spent_on, amount_minor: String(BigInt(form.amount) * 100n), channel: form.channel || undefined } }).catch(() => {}); setForm({ ...form, amount: '' }); load(); }}>Qo‘shish</button>
            {spend.length > 0 && <ul className="small spend-list">{spend.slice(0, 10).map((x) => <li key={x.id}>{x.spent_on} · {som(x.amount_minor)}{x.channel ? ` · ${x.channel}` : ''} <button className="link-btn small" onClick={async () => { await api(`/partner/ad-spend/${x.id}`, { method: 'DELETE' }).catch(() => {}); load(); }}>o‘chirish</button></li>)}</ul>}
          </details>
          <div className="ins-cols">
            <div className="card"><h3>Oqimlar bo‘yicha</h3>{d.by_stream.length ? d.by_stream.map((r: any, i: number) => <div key={i} className="sum-row"><span>{r.name}</span><span>{r.orders} / {r.delivered} ✓ · <b>{som(r.commission_minor)}</b></span></div>) : <p className="muted small">Ma’lumot yo‘q</p>}</div>
            <div className="card"><h3>Mahsulotlar bo‘yicha</h3>{d.by_product.length ? d.by_product.map((r: any, i: number) => <div key={i} className="sum-row"><span>{pick(r.name, lang)}</span><span>{r.units} dona · {r.delivered} ✓</span></div>) : <p className="muted small">Ma’lumot yo‘q</p>}</div>
            <div className="card"><h3>Hududlar bo‘yicha</h3>{d.by_district.length ? d.by_district.map((r: any, i: number) => <div key={i} className="sum-row"><span>{r.district}</span><b>{r.orders}</b></div>) : <p className="muted small">Ma’lumot yo‘q</p>}<p className="small muted">5 tadan kam buyurtmali hududlar maxfiylik uchun birlashtiriladi.</p></div>
          </div>
          <p className="small muted">Yangilangan: {new Date(d.updated_at).toLocaleString('uz-UZ')}</p>
        </>
      )}
    </section>
  );
}
