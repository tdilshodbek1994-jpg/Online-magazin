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
  const has = (v: string | null | undefined) => v !== null && v !== undefined;
  const pos = (v: string | null | undefined) => has(v) && BigInt(v!) > 0n;
  const verdict = (l: any) => l.result === null ? { cls: 'v-unknown', text: '❓ Xarajat kiritilmagan' } : BigInt(l.result) > 0n ? { cls: 'v-good', text: '✅ Foyda keltirdi' } : BigInt(l.result) < 0n ? { cls: 'v-bad', text: '⚠️ Zararda' } : { cls: 'v-unknown', text: '— Natija yo‘q' };
  const pct = (r: any) => (r.value === null ? '—' : `${r.value}%`);
  const SIMPLE: [string, string][] = [['today', 'Bugun'], ['this_week', 'Shu hafta'], ['this_month', 'Shu oy'], ['last_month', 'O‘tgan oy'], ['this_year', 'Shu yil']];
  return (
    <div className="an an-simple">
      <h1>Reklama va daromad</h1>
      <p className="an-lead">Bu yerda bitta savolga javob bor: <b>qancha pul topdim, reklamaga qancha ketdi va qo‘limda qancha qoldi?</b></p>

      <div className="sort-chips" role="group" aria-label="Davr">
        {SIMPLE.map(([k, l]) => <button key={k} className={`schip ${period === k ? 'on' : ''}`} aria-pressed={period === k} onClick={() => setPeriod(k)}>{l}</button>)}
      </div>

      {err && <div className="notice" role="alert">{err === 'PERIOD_INVALID' ? 'Sanani to‘g‘ri tanlang' : 'Ma’lumotni yuklab bo‘lmadi. Qayta urinib ko‘ring.'}</div>}
      {!d && !err && <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>}
      {d && (
        <>
          {/* The whole page in one line: earned − spent = left */}
          <section className="eq" aria-label="Asosiy natija">
            <Link href="/partner/wallet?reason=available" className="eq-item earn"><span>💰 Topdingiz ›</span><b>{money(t.commission)}</b><small>Komissiya — mahsulot mijozga yetib, pul tushgandan keyin</small></Link>
            <div className="eq-op" aria-hidden>−</div>
            <Link href="/partner/expenses" className="eq-item spend"><span>📣 Reklamaga sarfladingiz ›</span><b>{t.ad === null ? '?' : money(t.ad)}</b><small>{t.ad === null ? 'Hali kiritmagansiz' : 'Siz kiritgan reklama xarajati'}</small></Link>
            <div className="eq-op" aria-hidden>=</div>
            <div className={`eq-item left ${negative ? 'neg' : ''}`}><span>{negative ? '⚠️ Zarar' : '✅ Qo‘lingizda qoldi'}</span><b>{t.result === null ? '?' : money(t.result)}</b><small>{t.result === null ? 'Reklama xarajatini kiriting — shunda hisoblanadi' : negative ? 'Reklama topganingizdan ko‘p bo‘ldi' : 'Reklamadan keyingi sof natija'}</small></div>
          </section>
          {t.ad === null && <Link className="btn big full" href="/partner/expenses">📣 Reklamaga qancha sarflaganingizni kiriting</Link>}

          <Link href="/partner/wallet?reason=not_delivered" className="an-wait">
            <span>⏳ <b>Yana kutilmoqda: {money(t.expected)}</b> ›</span>
            <small>Bu buyurtmalar hali yetkazilmagan yoki pul tushmagan. Yetkazilgach “Topdingiz”ga qo‘shiladi. Hozircha yuqoridagi hisobga kirmaydi.</small>
          </Link>

          <details className="card an-how">
            <summary><b>❔ Komissiya qanday hisoblanadi?</b></summary>
            <ul>
              <li>Komissiya mahsulot narxi emas — bu har bir sotuv uchun sizga beriladigan haq.</li>
              <li>Mijoz bir buyurtmada 2–3 dona olsa, keyingi donalar uchun ham qo‘shimcha beriladi. Masalan, komissiya 30 000 bo‘lsa: <b>1 dona = 30 000</b>, <b>2 dona = 30 000 + 7 500 = 37 500</b>, <b>3 dona = 30 000 + 15 000 + 7 500 = 52 500</b>.</li>
              <li>Mijoz mahsulotni qaytarsa, komissiya qolgan donalar bo‘yicha qayta hisoblanadi (masalan 2 donadan 1 tasi qaytsa: 37 500 → 30 000).</li>
              <li>Reklama xarajatini kiritish hamyoningizdan pul yechmaydi — faqat “qancha qoldi”ni ko‘rsatadi.</li>
            </ul>
          </details>

          <section className="card an-sec">
            <h2>Buyurtmalar</h2>
            <div className="funnel">
              <Link href="/partner/orders?status=all"><b>{d.counts.orders}</b><span>ta buyurtma keldi ›</span></Link>
              <Link href="/partner/orders?status=accepted"><b>{d.counts.confirmed}</b><span>tasini mijoz tasdiqladi ›</span><small>{pct(d.ratios.confirmation)}</small></Link>
              <Link href="/partner/orders?status=delivered"><b>{d.counts.delivered}</b><span>tasi yetkazildi ›</span><small>{pct(d.ratios.delivery_total)}</small></Link>
              <div><b>{d.counts.units}</b><span>dona sotildi</span></div>
            </div>
          </section>

          <h2>Qaysi havola qancha olib keldi?</h2>
          <div className="slist">
            {d.links.filter((l: any) => l.orders > 0 || BigInt(l.commission) !== 0n || (l.ad && l.ad !== '0') || BigInt(l.expected) > 0n).slice(0, shown).map((l: any) => {
              const v = verdict(l);
              return (
                <article key={l.link_id ?? 'none'} className={`scard an-link2 ${v.cls}`}>
                  <div className="spread"><b>{l.link_id ? l.name : 'O‘zingiz kiritgan buyurtmalar'}{l.archived ? ' · arxiv' : ''}</b><span className={`verdict ${v.cls}`}>{v.text}</span></div>
                  {l.product && <div className="small muted">{pick(l.product, lang)}</div>}
                  <div className="eq-mini">
                    <span>Topdingiz <b>{money(l.commission)}</b></span>
                    <span>Reklama <b>{l.ad === null ? '?' : money(l.ad)}</b></span>
                    <span>Qoldi <b className={l.result && BigInt(l.result) < 0n ? 'no-t' : 'ok-t'}>{l.result === null ? '?' : money(l.result)}</b></span>
                  </div>
                  {l.link_id ? <Link className="small" href={`/partner/orders?link=${l.link_id}&link_name=${encodeURIComponent(l.name)}&status=all`}>{l.orders} buyurtma · {l.delivered} yetkazildi{BigInt(l.expected) > 0n ? ` · yana ${money(l.expected)} kutilmoqda` : ''} ›</Link> : <div className="small muted">{l.orders} buyurtma · {l.delivered} yetkazildi</div>}
                  {l.link_id && <div className="row" style={{ gap: 8 }}><Link className="btn secondary sm" href={`/partner/analytics/link/${l.link_id}?period=${period}`}>Batafsil</Link><Link className="btn secondary sm" href={`/partner/expenses?link=${l.link_id}`}>Reklama xarajati qo‘shish</Link></div>}
                </article>
              );
            })}
            {d.links.length > shown && <button className="btn secondary full" onClick={() => setShown(shown + 20)}>Yana ko‘rsatish</button>}
            {(d.unallocated.ad !== '0' || d.unallocated.other !== '0') && <p className="small muted">Yana {money((BigInt(d.unallocated.ad) + BigInt(d.unallocated.other)).toString())} reklama xarajati hech qaysi havolaga biriktirilmagan — u yuqoridagi umumiy hisobga kirgan.</p>}
          </div>

          <section className="card an-sec">
            <h2>Oy xulosasi</h2>
            <p>{d.summary_text}</p>
          </section>

          {d.completeness.fx_pending > 0 && <p className="small muted">💱 Ba’zi dollardagi xarajatlar uchun kurs hali yo‘q — ular hisobga kurs kelgach qo‘shiladi.</p>}
          {d.completeness.not_final && <p className="small muted">🕒 Ba’zi buyurtmalar hali yo‘lda — natija o‘zgarishi mumkin.</p>}

          <details className="card an-adv">
            <summary><b>⚙️ Batafsil (tajribali foydalanuvchilar uchun)</b></summary>
            <div className="an-filters">
              <div className="sort-chips" role="group" aria-label="Boshqa davrlar">{PERIODS.map(([k, l]) => <button key={k} className={`schip ${period === k ? 'on' : ''}`} aria-pressed={period === k} onClick={() => setPeriod(k)}>{l}</button>)}</div>
              {period === 'custom' && <div className="row"><label className="sr-only" htmlFor="af">Boshi</label><input id="af" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /><label className="sr-only" htmlFor="at">Oxiri</label><input id="at" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></div>}
              <div className="sort-chips" role="group" aria-label="Hisob usuli">
                <button className={`schip ${basis === 'financial' ? 'on' : ''}`} aria-pressed={basis === 'financial'} onClick={() => setBasis('financial')}>Shu davrda tushgan pul</button>
                <button className={`schip ${basis === 'cohort' ? 'on' : ''}`} aria-pressed={basis === 'cohort'} onClick={() => setBasis('cohort')}>Shu davrda kelgan mijozlar</button>
                <button className={`schip ${currency === 'UZS' ? 'on' : ''}`} aria-pressed={currency === 'UZS'} onClick={() => setCurrency('UZS')}>so‘m</button>
                <button className={`schip ${currency === 'USD' ? 'on' : ''}`} aria-pressed={currency === 'USD'} onClick={() => setCurrency('USD')}>dollar</button>
                <label className="sr-only" htmlFor="ach">Reklama manbasi</label>
                <select id="ach" className="schip" value={channel} onChange={(e) => setChannel(e.target.value)}>
                  <option value="">Barcha reklamalar</option><option value="telegram">Telegram</option><option value="instagram_target">Instagram</option><option value="unknown">Manbasi noma’lum</option>
                </select>
              </div>
              <p className="small muted">“Shu davrda tushgan pul” — shu oyda hisobingizga o‘tgan komissiya. “Shu davrda kelgan mijozlar” — shu oyda havolangizni bosib kelganlarning buyurtmalari (keyin yetkazilgan bo‘lsa ham).</p>
            </div>
            <h3>Vaqt bo‘yicha</h3>
            <SeriesChart series={d.series} money={(v) => money(v)} />
            <h3>Reklama manbalari</h3>
            {d.channels.map((c: any) => <div key={c.channel} className="sum-row"><span>{CH_LABEL[c.channel] ?? c.channel}</span><span>{c.orders} buyurtma · {money(c.commission)}</span></div>)}
            <h3>Ko‘rsatkichlar</h3>
            <div className="an-ratios">
              <div><span>1 ta yetkazilgan buyurtmaga reklama</span><b>{d.ratios.cost_per_delivered_order === null ? '—' : money(d.ratios.cost_per_delivered_order)}</b></div>
              <div><span>1 so‘m reklamadan topilgan komissiya</span><b>{d.ratios.commission_per_ad.value ?? '—'}</b></div>
            </div>
            {d.wallet && <p className="small">Hamyon: yechish mumkin <b>{som(d.wallet.available_minor)}</b> · so‘rovda <b>{som(d.wallet.reserved_minor)}</b> · to‘langan <b>{som(d.wallet.paid_minor)}</b></p>}
            {t.ad_shop_paid !== '0' && <p className="small muted">Do‘kon o‘zi to‘lagan reklama ({money(t.ad_shop_paid)}) sizning hisobingizdan ayirilmaydi.</p>}
            <div className="row" style={{ gap: 8 }}>
              <button className="btn secondary sm" onClick={exportCsv}>Excel uchun yuklab olish (CSV)</button>
              <Link className="btn secondary sm" href="/partner/analytics/plan">Oldindan hisoblab ko‘rish</Link>
            </div>
          </details>
          <p className="small muted">Yangilangan: {updated?.toLocaleTimeString('uz-UZ')}. Bu hisob ma’lumot uchun; hamyoningizdagi pulga ta’sir qilmaydi.</p>
        </>
      )}
    </div>
  );
}
