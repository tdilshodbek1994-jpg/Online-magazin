'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, getToken, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';
import { CH_LABEL, PERIODS, useMoney } from './shared';

/** Commission vs ad spend over time — one axis (same unit), grouped thin bars, hover tooltip, table view. */
function SeriesChart({ series, money }: { series: { key: string; commission: string; ad: string; result: string }[]; money: (v: string) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  if (!series.length) return <p className="muted small">Bu davrda harakat yo‘q.</p>;
  const max = Math.max(1, ...series.flatMap((s) => [Number(s.commission), Number(s.ad)]));
  const STEP = 36; const W = Math.max(320, series.length * STEP), H = 160, bw = 10; const every = Math.max(1, Math.ceil(series.length / 8));
  return (
    <div className="an-chart">
      <div className="an-legend"><span><i className="sw s-comm" />Komissiya</span><span><i className="sw s-ad" />Reklama</span><button className="link-btn small" onClick={() => setTable(!table)}>{table ? 'Grafik' : 'Jadval ko‘rinishi'}</button></div>
      {table ? (
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Davr jadvali"><table><thead><tr><th>Sana</th><th>Komissiya</th><th>Reklama</th><th>Natija</th></tr></thead>
          <tbody>{series.map((s) => <tr key={s.key}><td>{s.key}</td><td>{money(s.commission)}</td><td>{money(s.ad)}</td><td>{money(s.result)}</td></tr>)}</tbody></table></div>
      ) : (
        <div className="an-scroll">
          <svg width={W} height={H + 22} role="img" aria-label="Komissiya va reklama xarajati vaqt bo‘yicha">
            <line x1="0" x2={W} y1={H} y2={H} className="an-axis" />
            {series.map((s, i) => {
              const x = i * STEP + 6, hc = (Math.max(0, Number(s.commission)) / max) * (H - 8), ha = (Math.max(0, Number(s.ad)) / max) * (H - 8);
              return (
                <g key={s.key} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} tabIndex={0}>
                  <rect x={x - 4} y={0} width={STEP} height={H} fill="transparent" />
                  <rect x={x} y={H - hc} width={bw} height={hc} rx={3} className="b-comm" />
                  <rect x={x + bw + 2} y={H - ha} width={bw} height={ha} rx={3} className="b-ad" />
                  {(i % every === 0) && <text x={x + bw} y={H + 15} textAnchor="middle" className="an-tick">{s.key.slice(5)}</text>}
                </g>
              );
            })}
          </svg>
          {hover !== null && series[hover] && (
            <div className="an-tip" role="status"><b>{series[hover]!.key}</b><span><i className="sw s-comm" />{money(series[hover]!.commission)}</span><span><i className="sw s-ad" />{money(series[hover]!.ad)}</span><span>Natija: {money(series[hover]!.result)}</span></div>
          )}
        </div>
      )}
    </div>
  );
}

export default function PartnerAnalytics() {
  const { lang } = useI18n();
  const [period, setPeriod] = useState('this_month');
  const [range, setRange] = useState({ from: '', to: '' });
  const [basis, setBasis] = useState<'financial' | 'cohort'>('financial');
  const [currency, setCurrency] = useState<'UZS' | 'USD'>('UZS');
  const [channel, setChannel] = useState('');
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [updated, setUpdated] = useState<Date | null>(null);
  const [shown, setShown] = useState(10);
  const money = useMoney(currency);
  const qs = useCallback(() => {
    const p = new URLSearchParams({ period, basis, currency });
    if (period === 'custom') { if (!range.from || !range.to) return null; p.set('from', range.from); p.set('to', range.to); }
    if (channel) p.set('channel', channel);
    return p.toString();
  }, [period, basis, currency, channel, range]);
  const load = useCallback(() => {
    const q = qs(); if (!q) return;
    api(`/partner/analytics/dashboard?${q}`).then((r) => { setD(r); setErr(null); setUpdated(new Date()); }).catch((e) => setErr(e.code ?? 'ERROR'));
  }, [qs]);
  useEffect(() => { load(); }, [load]);
  // Short polling only while the tab is visible (spec §19); the last update time is shown.
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    const start = () => { if (!timer.current) timer.current = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 30_000); };
    const stop = () => { if (timer.current) { clearInterval(timer.current); timer.current = null; } };
    const vis = () => (document.visibilityState === 'visible' ? (load(), start()) : stop());
    start(); document.addEventListener('visibilitychange', vis);
    return () => { stop(); document.removeEventListener('visibilitychange', vis); };
  }, [load]);
  const exportCsv = async () => {
    const q = qs(); if (!q) return;
    const r = await fetch(`/api/v1/partner/analytics/export.csv?${q}`, { headers: { 'x-session-token': getToken() ?? '' } });
    const blob = await r.blob();
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `uzshop-hisobot-${period}.csv`; a.click(); URL.revokeObjectURL(a.href);
  };
  const t = d?.totals;
  const negative = t?.result && BigInt(t.result) < 0n;
  return (
    <div className="an">
      <div className="spread"><h1>Reklama va daromad</h1><Link className="btn sm" href="/partner/expenses">+ Xarajat</Link></div>
      <div className="an-filters">
        <div className="sort-chips" role="group" aria-label="Davr">{PERIODS.map(([k, l]) => <button key={k} className={`schip ${period === k ? 'on' : ''}`} aria-pressed={period === k} onClick={() => setPeriod(k)}>{l}</button>)}</div>
        {period === 'custom' && <div className="row"><label className="sr-only" htmlFor="af">Boshi</label><input id="af" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /><label className="sr-only" htmlFor="at">Oxiri</label><input id="at" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></div>}
        <div className="sort-chips" role="group" aria-label="Hisobot turi">
          <button className={`schip ${basis === 'financial' ? 'on' : ''}`} aria-pressed={basis === 'financial'} onClick={() => setBasis('financial')} title="Shu davrda tan olingan komissiya va shu davrga tegishli reklama">Davrdagi moliyaviy natija</button>
          <button className={`schip ${basis === 'cohort' ? 'on' : ''}`} aria-pressed={basis === 'cohort'} onClick={() => setBasis('cohort')} title="Shu davrda kelgan mijozlar buyurtmalari va ularning hozirgi holati">Reklama/kampaniya natijasi</button>
          <button className={`schip ${currency === 'UZS' ? 'on' : ''}`} aria-pressed={currency === 'UZS'} onClick={() => setCurrency('UZS')}>so‘m</button>
          <button className={`schip ${currency === 'USD' ? 'on' : ''}`} aria-pressed={currency === 'USD'} onClick={() => setCurrency('USD')}>USD</button>
          <label className="sr-only" htmlFor="ach">Manba</label>
          <select id="ach" className="schip" value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="">Barcha manbalar</option><option value="telegram">Telegram (hammasi)</option><option value="telegram_channel">Telegram kanal</option><option value="telegram_ads">Telegram Ads</option><option value="instagram_target">Instagram target</option><option value="unknown">Manba ajratilmagan</option>
          </select>
        </div>
      </div>
      {err && <div className="notice" role="alert">{err === 'PERIOD_INVALID' ? 'Sana oralig‘ini to‘g‘ri tanlang' : err}</div>}
      {!d && !err && <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>}
      {d && (
        <>
          <div className="an-cards">
            <div className="an-card"><span>Komissiya daromadi</span><b>{money(t.commission)}</b><small>{basis === 'financial' ? 'Shu davrda tan olingan (qaytarishlar hisobga olingan)' : 'Shu davr mijozlaridan tasdiqlangan'}</small></div>
            <div className="an-card"><span>Reklama xarajati</span><b>{money(t.ad)}</b><small>{t.ad === null ? 'Xarajat kiritilmagan' : d.completeness.expense_zero_confirmed && t.ad === '0' ? 'Siz “xarajat yo‘q” deb tasdiqlagansiz' : 'Siz to‘lagan; xizmat kunlari bo‘yicha'}</small></div>
            <div className={`an-card main ${negative ? 'neg' : ''}`}><span>Reklamadan keyingi natija</span><b>{t.result === null ? 'Hisob to‘liq emas' : money(t.result)}</b><small>komissiya − reklama − boshqa xarajat{t.other && t.other !== '0' ? ` (${money(t.other)})` : ''}</small></div>
            <div className="an-card"><span>Kutilayotgan komissiya</span><b>{money(t.expected)}</b><small>Shartlar hali bajarilmagan — natijaga qo‘shilmaydi</small></div>
          </div>
          <div className="an-sub">
            {d.wallet && <><span>Yechish mumkin: <b>{som(d.wallet.available_minor)}</b></span><span>So‘rovda: <b>{som(d.wallet.reserved_minor)}</b></span><span>To‘langan: <b>{som(d.wallet.paid_minor)}</b></span></>}
            <span>Buyurtma: <b>{d.counts.orders}</b> · tasdiqlangan <b>{d.counts.confirmed}</b> · yetkazilgan <b>{d.counts.delivered}</b> · dona <b>{d.counts.units}</b></span>
            {t.ad_shop_paid !== '0' && <span>Do‘kon to‘lagan reklama: <b>{money(t.ad_shop_paid)}</b> (natijangizdan ayirilmaydi)</span>}
          </div>
          {d.completeness.notes.length > 0 && <div className="notice small">{d.completeness.notes.join(' · ')}</div>}

          <section className="card an-sec"><h2>Oy xulosasi</h2><p>{d.summary_text}</p>
            {d.compare?.commission_growth_pct !== null && d.compare?.commission_growth_pct !== undefined && <p className="small muted">O‘tgan teng davrga nisbatan komissiya: {d.compare.commission_growth_pct > 0 ? '+' : ''}{d.compare.commission_growth_pct}%</p>}
          </section>

          <section className="card an-sec"><h2>Vaqt bo‘yicha</h2><SeriesChart series={d.series} money={(v) => money(v)} /></section>

          <section className="card an-sec">
            <h2>Foizlar</h2>
            <div className="an-ratios">
              {(['confirmation', 'delivery', 'delivery_total', 'ad_result_pct'] as const).map((k) => (
                <div key={k} title={d.ratios[k].formula}><span>{d.ratios[k].label}</span><b>{d.ratios[k].value === null ? 'Hisoblanmaydi' : `${d.ratios[k].value}%`}</b><small>{k === 'ad_result_pct' ? 'natija / reklama' : `${d.ratios[k].num}/${d.ratios[k].den}`}</small></div>
              ))}
              <div><span>Komissiya / reklama</span><b>{d.ratios.commission_per_ad.value ?? 'Hisoblanmaydi'}</b></div>
              <div><span>1 yetkazilgan buyurtma xarajati</span><b>{d.ratios.cost_per_delivered_order === null ? 'Hisoblanmaydi' : money(d.ratios.cost_per_delivered_order)}</b></div>
            </div>
          </section>

          <section className="card an-sec">
            <h2>Manbalar</h2>
            {d.channels.length === 0 ? <p className="muted small">Ma’lumot yo‘q</p> : d.channels.map((c: any) => (
              <div key={c.channel} className="sum-row"><span>{CH_LABEL[c.channel] ?? c.channel}</span><span>{c.orders} buyurtma · <b>{money(c.commission)}</b> · reklama {money(c.ad)}</span></div>
            ))}
            <p className="small muted">“Manba ajratilmagan” — eski havola Telegram va Instagram’da birga tarqatilgan; tarix taxmin bilan bo‘linmaydi.</p>
          </section>

          <h2>Havolalar</h2>
          <div className="small muted">Yangi: {d.link_counts.created_in_period} · Faol: {d.link_counts.active} · Daromad keltirgan: {d.link_counts.with_revenue}</div>
          <div className="slist">
            {d.links.slice(0, shown).map((l: any) => (
              <article key={l.link_id ?? 'none'} className={`scard an-link ${l.archived ? 'muted-card' : ''}`}>
                <div className="spread"><b>{l.name}{l.archived ? ' · arxiv' : ''}</b><span className="small muted">{l.product ? pick(l.product, lang) : ''}</span></div>
                <div className="an-link-grid">
                  <div><span>Komissiya</span><b>{money(l.commission)}</b></div>
                  <div><span>Reklama</span><b>{money(l.ad)}</b></div>
                  <div><span>Natija</span><b className={l.result && BigInt(l.result) < 0n ? 'no-t' : ''}>{l.result === null ? 'Hisob to‘liq emas' : money(l.result)}</b></div>
                  <div><span>Kutilmoqda</span><b>{money(l.expected)}</b></div>
                </div>
                <div className="small muted">{l.orders} buyurtma · {l.delivered} yetkazilgan · {l.units} dona · 1/2/3 dona: {l.qty_distribution['1']}/{l.qty_distribution['2']}/{l.qty_distribution['3']}{l.qty_distribution['4+'] ? ` · 4+: ${l.qty_distribution['4+']}` : ''}</div>
                {l.link_id && <div className="row" style={{ gap: 8 }}><Link className="btn secondary sm" href={`/partner/analytics/link/${l.link_id}?period=${period}`}>Hisob-kitob</Link><Link className="btn secondary sm" href={`/partner/expenses?link=${l.link_id}`}>Xarajat qo‘shish</Link></div>}
              </article>
            ))}
            {d.links.length > shown && <button className="btn secondary full" onClick={() => setShown(shown + 20)}>Yana ko‘rsatish ({d.links.length - shown} ta havola)</button>}
            {(d.unallocated.ad !== '0' || d.unallocated.other !== '0') && <article className="scard"><div className="spread"><b>Taqsimlanmagan xarajat</b><b>{money((BigInt(d.unallocated.ad) + BigInt(d.unallocated.other)).toString())}</b></div><div className="small muted">Havolaga biriktirilmagan, lekin umumiy natijaga kiradi.</div></article>}
          </div>
          <div className="row" style={{ marginTop: 12, gap: 8 }}>
            <button className="btn secondary" onClick={exportCsv}>CSV yuklab olish</button>
            <Link className="btn secondary" href="/partner/analytics/plan">Rejalashtirish (taxmin)</Link>
          </div>
          <p className="small muted">Hisobot: {basis === 'financial' ? 'davrdagi moliyaviy natija' : 'reklama/kampaniya natijasi'} · {d.fx_method} · Asia/Tashkent · yangilangan {updated?.toLocaleTimeString('uz-UZ')}. Bu tahliliy hisob — buxgalteriyaning yakuniy sof foyda hisoboti emas va hamyondan pul yechmaydi.</p>
        </>
      )}
    </div>
  );
}
