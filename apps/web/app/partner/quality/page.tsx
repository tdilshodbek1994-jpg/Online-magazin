'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errText } from '@/lib/errors';
import { toast } from '@/lib/toast';

const RATE_UZ: Record<string, string> = { confirmation_rate: 'Tasdiqlanish', delivery_rate: 'Yetkazilish', customer_denial_rate: 'Mijoz rad etishi', verified_invalid_rate: 'Isbotlangan qoidabuzarlik' };
/** Where a metric's orders can be seen (same 30-day window). */
const RATE_HREF: Record<string, [string, string]> = { confirmation_rate: ['/partner/orders?status=all&period=d30', 'Buyurtmalarni ko‘rish →'], delivery_rate: ['/partner/orders?status=delivered&period=d30', 'Yetkazilganlarni ko‘rish →'], customer_denial_rate: ['/partner/orders?status=cancelled&period=d30', 'Bekor qilinganlarni ko‘rish →'], verified_invalid_rate: ['#cases', 'Tekshiruvlarni ko‘rish →'] };
const STATUS_UZ: Record<string, string> = { detected: 'Aniqlandi', triage: 'Ko‘rib chiqilmoqda', investigating: 'Tekshirilmoqda', awaiting_partner_response: 'Javobingiz kutilmoqda', reviewed: 'Ko‘rib chiqildi', resolved_no_fault: 'Ayb yo‘q', confirmed_violation: 'Qoidabuzarlik tasdiqlandi', inconclusive: 'Aniq emas (ayb emas)', appealed: 'Apellyatsiyada', final: 'Yakuniy' };

/** Partner «Sifat»: own explained metrics, warnings, active restrictions, cases with reply and appeal. */
export default function PartnerQuality() {
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const [text, setText] = useState<Record<string, string>>({});
  const load = useCallback(() => { api('/partner/quality').then(setD).catch(setErr); }, []);
  useEffect(load, [load]);
  if (err) return <div className="notice" role="alert">{errText(err)}</div>;
  if (!d) return <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>;
  const send = async (id: string, kind: 'response' | 'appeal') => {
    const v = (text[id] ?? '').trim(); if (v.length < 5) return;
    try { await api(`/partner/quality/cases/${id}/${kind}`, { method: 'POST', body: kind === 'response' ? { text: v } : { body: v } }); toast(kind === 'response' ? '✓ Javobingiz yuborildi' : '✓ Apellyatsiya yuborildi'); setText({ ...text, [id]: '' }); load(); }
    catch (e: any) { toast(errText(e), 'err'); }
  };
  return (
    <div className="cc">
      <h1>Sifat ko‘rsatkichlarim</h1>
      <p className="muted small">{d.note}</p>
      <div className="slist">
        {d.rates.map((r: any) => (
          <Link key={r.metric} href={RATE_HREF[r.metric]?.[0] ?? '/partner/orders'} className="scard notif-link q-card">
            <div className="spread"><b>{RATE_UZ[r.metric]}</b><b>{r.value_pct === null ? '—' : `${r.value_pct}%`}</b></div>
            <div className="small muted">{r.numerator} / {r.denominator} · oxirgi {r.period_days} kun · {r.explain}{r.sample_size < (d.policy?.min_sample ?? 20) ? ' · ma’lumot hali kam, xulosa chiqarilmaydi' : ''}</div>
            <div className="notif-more">{RATE_HREF[r.metric]?.[1] ?? 'Batafsil →'}</div>
          </Link>
        ))}
      </div>
      {d.restrictions.length > 0 && <section className="card"><b>Vaqtinchalik cheklovlar</b>{d.restrictions.map((x: any, i: number) => <div key={i} className="small">{x.kind} — {x.reason} · {new Date(x.ends_at).toLocaleDateString('uz-UZ')} gacha</div>)}</section>}
      {d.warnings.length > 0 && <section className="card"><b>Ogohlantirishlar</b>{d.warnings.map((w: any) => <div key={w.id} className="small w-prod">#{w.level}: {w.message}{w.partner_response ? <div className="muted">Javobingiz: {w.partner_response}</div> : null}</div>)}</section>}
      <h2 className="an-h2" id="cases">Tekshiruvlar</h2>
      {d.cases.length === 0 && <p className="muted small">Sizga tegishli tekshiruv yo‘q ✓</p>}
      {d.cases.map((c: any) => (
        <div key={c.id} className="scard">
          <div className="spread"><b>{STATUS_UZ[c.status] ?? c.status}</b><span className="small muted">{new Date(c.created_at).toLocaleDateString('uz-UZ')}</span></div>
          {c.decision && <div className="small">Qaror izohi: {c.decision}</div>}
          {!['final', 'resolved_no_fault', 'inconclusive'].includes(c.status) && (
            <>
              <textarea rows={2} aria-label="Izohingiz" value={text[c.id] ?? ''} onChange={(e) => setText({ ...text, [c.id]: e.target.value })} placeholder="Izohingiz yoki dalilingiz" />
              <div className="row" style={{ gap: 8 }}>
                <button className="btn secondary sm" onClick={() => send(c.id, 'response')}>Javob yuborish</button>
                {c.status === 'confirmed_violation' && <button className="btn sm" onClick={() => send(c.id, 'appeal')}>Apellyatsiya</button>}
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
