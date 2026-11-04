'use client';
import Link from 'next/link';
import { use, useCallback, useEffect, useState } from 'react';
import { api, som } from '@/lib/api';
import { errText } from '@/lib/errors';
import { toast } from '@/lib/toast';
import { dt, fmtScore, METRIC_UZ, STATUS_UZ } from '../shared';
import { Podium } from '@/components/Podium';

/** One contest for a partner: rules, prizes, voluntary join, leaderboard (aliases), my result with counted orders, appeal. */
export default function ContestDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [c, setC] = useState<any>(null);
  const [lb, setLb] = useState<any>(null);
  const [me, setMe] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const [consent, setConsent] = useState(false);
  const [agree, setAgree] = useState(false);
  const [appeal, setAppeal] = useState('');
  const load = useCallback(() => {
    api(`/partner/cc/contests/${id}`).then(setC).catch(setErr);
    api(`/partner/cc/contests/${id}/leaderboard`).then(setLb).catch(() => {});
    api(`/partner/cc/contests/${id}/me`).then(setMe).catch(() => {});
  }, [id]);
  useEffect(load, [load]);
  if (err) return <div className="notice" role="alert">{errText(err)}</div>;
  if (!c) return <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>;
  const r = c.rules;
  const joined = c.enrollment && !c.enrollment.left_at;
  const canJoin = ['scheduled', 'active'].includes(c.status);
  return (
    <div className="cc watch">
      <Link href="/partner/contests" className="see-all">← Konkurs markazi</Link>
      <div className="spread"><h1>{r.title_latn}</h1><span className={`pill ${STATUS_UZ[c.status]?.[1] ?? ''}`}>{STATUS_UZ[c.status]?.[0] ?? c.status}</span></div>
      <p className="small muted">{dt(r.starts_at)} — {dt(r.ends_at)} (Toshkent vaqti) · qoidalar v{r.version}</p>
      {r.description && <p className="small">{r.description}</p>}

      <section className="card cc-rules">
        <b>Qanday hisoblanadi</b>
        <ul className="small">
          <li>Ko‘rsatkich: <b>{METRIC_UZ[r.metric]}</b>.</li>
          <li>Faqat konkurs davrida tushgan, sizga tegishli, <b>yetkazilgan va to‘lovi tasdiqlangan</b> buyurtmalar hisoblanadi. Qaytarilgan dona hisobdan chiqadi.</li>
          <li>Teng bo‘lsa: avval ball, keyin sof savdo, keyin qaytarishlar ulushi, keyin shu natijaga birinchi erishgan. Tasodifiy g‘olib yo‘q.</li>
          <li>Eng kam natija: {fmtScore(r.metric, r.min_score)}. Yakunlangach {r.appeal_days} kun e’tiroz muddati bor, keyin g‘oliblar tasdiqlanadi.</li>
        </ul>
        {c.revisions.length > 0 && <div className="small notice">Qoidalar yangilangan: {c.revisions.map((x: any) => `v${x.version} — ${x.reason}`).join('; ')}</div>}
        {r.terms && <details className="small"><summary>To‘liq shartlar</summary><p style={{ whiteSpace: 'pre-wrap' }}>{r.terms}</p></details>}
      </section>

      {c.prizes.length > 0 && (
        <section className="card"><b>🏆 Sovrinlar</b>
          {c.prizes.map((p: any, i: number) => <div key={i} className="spread small w-prod"><span>{p.place ? `${p.place}-o‘rin` : p.nomination ?? 'Nominatsiya'}</span><b>{p.title}{p.kind === 'money' && p.value_minor !== '0' ? ` · ${som(p.value_minor)}` : ''}{p.qty > 1 ? ` × ${p.qty}` : ''}</b></div>)}
        </section>
      )}

      {!joined && canJoin && (
        <section className="card cc-join">
          <label className="s-check"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> Shartlar bilan tanishdim va qatnashaman</label>
          <label className="s-check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> Reytingda ismim ko‘rinsin (aks holda taxallus)</label>
          <button className="btn" disabled={!agree} onClick={async () => { try { await api(`/partner/cc/contests/${id}/join`, { method: 'POST', body: { accept_terms: true, display_consent: consent } }); toast('✓ Konkursga qo‘shildingiz'); load(); } catch (e: any) { toast(e.code === 'CONTEST_NOT_ELIGIBLE' ? 'Bu konkurs faqat yangi hamkorlar uchun.' : errText(e), 'err'); } }}>Qatnashaman</button>
        </section>
      )}

      {joined && me && (
        <section className="card">
          <b>Mening natijam</b>
          <div className="an-mini">
            <div><b className="ok-t">{fmtScore(me.metric, me.final)}</b><span>yakuniy</span></div>
            <div><b>{fmtScore(me.metric, me.provisional)}</b><span>dastlabki</span></div>
            <div><b>{lb?.me?.rank ?? '—'}</b><span>o‘rin</span></div>
            <div><b>{me.funnel.delivery_from_accepted_pct ?? '—'}{me.funnel.delivery_from_accepted_pct !== null ? '%' : ''}</b><span>yetkazish</span></div>
          </div>
          <p className="small muted">Dastlabki — yetkazilgan, lekin to‘lovi hali tasdiqlanmaganlar ham kiradi. Yakuniy — faqat to‘lovi tasdiqlanganlar.</p>
          {me.orders.length > 0 && <details><summary className="small">Hisoblangan buyurtmalar ({me.orders.length})</summary>
            {me.orders.map((o: any) => <Link key={o.order_id} href={`/partner/orders/${o.order_id}`} className="spread small w-prod"><span>{o.number}{o.adjustments ? ' · tuzatilgan' : ''}</span><span>{fmtScore(me.metric, o.final)} <span className="muted">(dastlabki {fmtScore(me.metric, o.prov)})</span> ›</span></Link>)}
          </details>}
          {me.corrections.length > 0 && <div className="small">Tuzatishlar: {me.corrections.map((x: any) => `${x.points} — ${x.reason}`).join('; ')}</div>}
          {canJoin && <button className="link-btn small" onClick={async () => { if (!confirm('Konkursdan chiqasizmi? Oddiy komissiyangiz o‘zgarmaydi.')) return; await api(`/partner/cc/contests/${id}/leave`, { method: 'POST' }).catch(() => {}); load(); }}>Konkursdan chiqish</button>}
        </section>
      )}

      {lb && (
        <section className="card">
          <div className="spread"><b>Reyting</b><span className="small muted">{lb.kind === 'final' ? 'Yakuniy' : lb.kind === 'provisional' ? 'Dastlabki' : 'Jonli'} · {dt(lb.as_of)}</span></div>
          {lb.warning && <p className="small muted">⚠️ {lb.warning}</p>}
          <Podium rows={lb.items.map((x: any) => ({ rank: x.rank, name: x.name, value: fmtScore(r.metric, x.score), me: x.me }))} />
        </section>
      )}

      {joined && c.status === 'appeal_window' && (
        <section className="card">
          <b>E’tiroz bildirish</b>
          <p className="small muted">Muddat: {dt(c.appeal_deadline)} gacha. Masalan, buyurtmangiz hisobga kirmagan bo‘lsa yozing.</p>
          <textarea rows={3} value={appeal} onChange={(e) => setAppeal(e.target.value)} aria-label="E’tiroz matni" />
          <button className="btn secondary sm mt8" disabled={appeal.trim().length < 5} onClick={async () => { try { await api(`/partner/cc/contests/${id}/appeals`, { method: 'POST', body: { body: appeal } }); setAppeal(''); toast('✓ E’tiroz yuborildi'); } catch (e: any) { toast(e.code === 'APPEAL_WINDOW_CLOSED' ? 'E’tiroz muddati tugagan.' : errText(e), 'err'); } }}>Yuborish</button>
        </section>
      )}
    </div>
  );
}
