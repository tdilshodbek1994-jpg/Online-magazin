'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errText } from '@/lib/errors';
import { toast } from '@/lib/toast';
import { LevelBadge } from '@/components/LevelBadge';

const n = (v: number | string) => String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const CP: Record<string, string> = { available: 'Tayyor — faollashtiring', armed: 'Keyingi mos buyurtmaga qo‘llanadi', reserved: 'Buyurtmaga band qilingan (yakunlanishini kutmoqda)', used: 'Ishlatilgan', void: 'Faol emas (sotuvlar chegaradan pastga tushgan)' };

/** Partner «🎖️ Darajam»: level badge, progress, perks, coins, gift discount, coupon, VIP, history, rank, advice. */
export default function LevelPage() {
  const [d, setD] = useState<any>(null);
  const [adv, setAdv] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => { api('/partner/level').then(setD).catch((e) => setErr(errText(e))); api('/partner/level/advice').then(setAdv).catch(() => {}); }, []);
  useEffect(load, [load]);
  if (err) return <div className="empty">{err}</div>;
  if (!d) return <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>;
  const L = d.level;
  return (
    <section className="lvl-page">
      <div className="lvl-hero" style={{ background: `linear-gradient(135deg, ${L.color}, #0b1f17)` }}>
        <div className="lvl-badge-big"><LevelBadge level={L.level} color={L.color} symbol={L.badge} size={92} /></div>
        <div>
          <div className="small" style={{ opacity: 0.85 }}>{L.level > 0 ? `${L.level}-daraja` : 'Boshlang‘ich'}</div>
          <h1>{L.name}</h1>
          <div className="small">Hisobga olingan sotuvlar: <b>{n(d.units)}</b> dona · Reytingda #{d.rank.position} / {d.rank.of}</div>
        </div>
      </div>
      {d.next ? (
        <div className="card">
          <div className="spread small"><span>Keyingi: {d.next.badge} <b>{d.next.name}</b></span><span>{n(d.next.remaining)} ta qoldi</span></div>
          <div className="lvl-bar" role="progressbar" aria-valuenow={d.next.progress_pct} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${d.next.progress_pct}%`, background: L.color }} /></div>
          <p className="small muted">Faqat yetkazilgan va hisob-kitobi tasdiqlangan donalar sanaladi. Bekor qilingan va qaytarilganlar hisobga kirmaydi.</p>
        </div>
      ) : <div className="card"><b>🏆 Eng yuqori daraja!</b></div>}
      <div className="tr-grid">
        <div className="tile"><b>🪙 {n(d.coins_available)}</b><span className="small muted">UzCoin balansi</span></div>
        <div className="tile"><b>{d.gift_discount_bps / 100}%</b><span className="small muted">Sovg‘alarga chegirma</span></div>
        <div className="tile"><b>{d.vip.active ? '50% VIP' : '—'}</b><span className="small muted">VIP komissiya ({n(d.vip.unlocks_at)} dan)</span></div>
      </div>
      <div className="card">
        <b>🎟️ 50% komissiya kuponi</b>
        {d.coupon ? <>
          <p className="small">{CP[d.coupon.status] ?? d.coupon.status}</p>
          {d.coupon.status === 'available' && <button className="btn sm" onClick={async () => { try { await api('/partner/level/coupon/arm', { method: 'POST' }); toast('✓ Kupon keyingi mos buyurtmaga qo‘llanadi'); load(); } catch (e) { toast(errText(e), 'err'); } }}>Faollashtirish</button>}
        </> : <p className="small muted">{n(d.coupon_unlocks_at)} ta sotuvda bir martalik kupon ochiladi.</p>}
        <p className="small muted">50% faqat admin belgilagan mahsulotlarga va marja yetarli bo‘lsa qo‘llanadi{d.benefit_products.length ? `: ${d.benefit_products.slice(0, 5).map((p: any) => p.name?.['uz-Latn']).join(', ')}${d.benefit_products.length > 5 ? '…' : ''}` : ' (hozircha mahsulot belgilanmagan)'}.</p>
      </div>
      {adv && <div className="card"><b>🤖 Keyingi darajaga tavsiya</b><ul className="small" style={{ paddingLeft: 18 }}>{adv.tips.map((t: string) => <li key={t}>{t}</li>)}</ul><p className="small muted">{adv.note}</p></div>}
      <section className="card lvl-road-card">
        <div className="spread"><b>🗺️ Darajalar yo‘li</b><span className="small muted">{d.defs.filter((x: any) => d.units >= x.threshold).length}/{d.defs.length} ochilgan</span></div>
        <ol className="lvl-road">
          {d.defs.map((x: any, i: number) => {
            const done = d.units >= x.threshold && x.level !== L.level;
            const cur = x.level === L.level;
            const nextDef = d.defs[i + 1];
            const pct = cur && nextDef ? Math.min(100, Math.max(0, ((d.units - x.threshold) / (nextDef.threshold - x.threshold)) * 100)) : done ? 100 : 0;
            return (
              <li key={x.level} className={`lvl-step ${done ? 'done' : cur ? 'cur' : 'locked'}`} style={{ ['--lc' as any]: x.color }}>
                <div className="lvl-rail"><span className="lvl-medal"><LevelBadge level={x.level} color={x.color} symbol={x.badge} size={cur ? 56 : 46} locked={!done && !cur} />{done && <i className="lvl-tick">✓</i>}{!done && !cur && <i className="lvl-lock">🔒</i>}</span>{i < d.defs.length - 1 && <span className="lvl-line"><i style={{ height: `${pct}%` }} /></span>}</div>
                <div className="lvl-body">
                  <div className="lvl-row1"><b className="lvl-name">{x.name}</b>{cur && <span className="lvl-you">Siz shu yerdasiz</span>}</div>
                  <div className="lvl-row2">
                    <span className="lvl-chip">🎯 {n(x.threshold)} sotuv</span>
                    {x.gift_discount_bps > 0 && <span className="lvl-chip gift">🎁 −{x.gift_discount_bps / 100}% sovg‘a</span>}
                    {x.perks && <span className="lvl-chip perk">⭐ {x.perks}</span>}
                  </div>
                  {cur && nextDef && <div className="lvl-mini"><span style={{ width: `${pct}%` }} /></div>}
                  {!done && !cur && <div className="small muted">yana {n(x.threshold - d.units)} ta sotuv</div>}
                </div>
              </li>
            );
          })}
        </ol>
      </section>
      {d.history.length > 0 && <details className="card pp-more"><summary>Darajalar tarixi</summary>{d.history.map((h: any, i: number) => <div key={i} className="spread small"><span>{h.from_level} → {h.to_level} ({n(h.units)} dona)</span><span>{new Date(h.created_at).toLocaleDateString('uz')}</span></div>)}</details>}
      <Link className="btn secondary sm" href="/partner/uzcoin">🪙 Sovg‘alar do‘koni</Link>
    </section>
  );
}
