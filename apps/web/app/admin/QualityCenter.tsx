'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errText } from '@/lib/errors';
import { toast } from '@/lib/toast';

export const RATE_UZ: Record<string, string> = { confirmation_rate: 'Tasdiqlanish', delivery_rate: 'Yetkazilish', customer_denial_rate: 'Mijoz rad etishi', verified_invalid_rate: 'Isbotlangan qoidabuzarlik' };
const REASON_UZ: Record<string, string> = { low_metric: 'Past ko‘rsatkich', customer_denied: 'Mijoz «buyurtma bermaganman» dedi', same_phone: 'Bir telefon', wrong_address_repeat: 'Qayta-qayta noto‘g‘ri manzil', unreachable_customers: 'Mijozlarga bog‘lanib bo‘lmaydi', many_returns: 'Ko‘p qaytarish', unusual_campaign: 'Noodatiy kampaniya', other: 'Boshqa' };
const STATUS_UZ: Record<string, string> = { detected: 'Aniqlandi', triage: 'Saralash', investigating: 'Tekshirilmoqda', awaiting_partner_response: 'Hamkor javobi kutilmoqda', reviewed: 'Ko‘rib chiqildi', resolved_no_fault: 'Ayb yo‘q', confirmed_violation: 'Qoidabuzarlik tasdiqlandi', inconclusive: 'Aniq emas (ayb emas)', appealed: 'Apellyatsiyada', final: 'Yakuniy' };
const NEXT: Record<string, string[]> = { detected: ['triage', 'resolved_no_fault'], triage: ['investigating', 'resolved_no_fault'], investigating: ['awaiting_partner_response', 'reviewed'], awaiting_partner_response: ['reviewed'], reviewed: ['resolved_no_fault', 'confirmed_violation', 'inconclusive'], resolved_no_fault: ['final'], confirmed_violation: ['final'], inconclusive: ['final'] };

/** Admin «Sifat markazi»: risk inbox (signals, never automatic fault), case workflow, warnings. */
export function QualityCenterAdmin() {
  const [d, setD] = useState<any>(null);
  const load = useCallback(() => { api('/admin/quality/inbox').then(setD).catch((e) => toast(errText(e), 'err')); }, []);
  useEffect(load, [load]);
  const transition = async (c: any, to: string) => {
    const reason = prompt(`Sabab (${STATUS_UZ[to]})`); if (!reason) return;
    const fault = to === 'confirmed_violation' ? prompt('Kim aybdor? partner / operator / warehouse / courier / customer', 'partner') ?? undefined : undefined;
    try {
      const full = (await api(`/admin/quality/partners/${c.partner_id}`)).cases.find((x: any) => x.id === c.id);
      await api(`/admin/quality/cases/${c.id}/transition`, { method: 'POST', body: { to, reason, fault, expected_version: full.version } });
      if (to === 'confirmed_violation' && fault === 'partner' && confirm('Neytral ogohlantirish yuborilsinmi?')) {
        const message = prompt('Ogohlantirish matni (o‘qitish/maslahat)', 'Iltimos, mijoz roziligini aniq qayd eting va buyurtmani mijoz bilan tekshiring.');
        if (message) await api(`/admin/quality/cases/${c.id}/warning`, { method: 'POST', body: { message } });
      }
      toast('✓ Saqlandi'); load();
    } catch (e: any) { toast(errText(e), 'err'); }
  };
  if (!d) return <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>;
  return (
    <section style={{ marginTop: 12 }} className="cc">
      <h2>Sifat markazi</h2>
      <p className="notice small">{d.note} Pul jarimasi faqat shartnoma va yuridik tasdiqdan keyin yoqiladi.</p>
      <div className="small muted">{d.policy ? `Siyosat v${d.policy.version}: ${RATE_UZ[d.policy.metric]} ${d.policy.metric.includes('rate') && ['confirmation_rate', 'delivery_rate'].includes(d.policy.metric) ? '<' : '>'} ${d.policy.threshold_pct}% (kamida ${d.policy.min_sample} ta yakunlangan, ${d.policy.period_days} kun)` : 'Faol siyosat yo‘q — signal hisoblanmaydi.'}</div>
      <h3 className="an-h2">Signallar ({d.signals.length})</h3>
      {d.signals.length === 0 && <p className="muted small">Signal yo‘q.</p>}
      {d.signals.map((x: any) => (
        <div key={x.partner.id} className="scard">
          <div className="spread"><b>{x.partner.display_name} ({x.partner.code})</b><b className="no-t">{x.rate.value_pct}%</b></div>
          <div className="small muted">{RATE_UZ[x.rate.metric]}: {x.rate.numerator} / {x.rate.denominator} · {x.rate.period_days} kun · {x.rate.explain}</div>
          <button className="btn secondary sm" onClick={async () => { try { await api('/admin/quality/cases', { method: 'POST', body: { partner_id: x.partner.id, reason_code: 'low_metric', idem_key: `low:${x.partner.id}:${new Date().toISOString().slice(0, 10)}`, evidence: [{ rate: x.rate }] } }); toast('✓ Tekshiruv ochildi'); load(); } catch (e: any) { toast(errText(e), 'err'); } }}>Tekshiruv ochish</button>
        </div>
      ))}
      <h3 className="an-h2">Bir telefon — bir necha buyurtma</h3>
      {d.same_phone.length === 0 && <p className="muted small">Yo‘q.</p>}
      {d.same_phone.slice(0, 10).map((x: any) => <div key={x.partner_id} className="spread small w-prod"><span>{x.display_name} ({x.code})</span><span>{x.orders} buyurtma / {x.phones} telefon</span></div>)}
      {d.same_phone.length > 0 && <p className="muted small">{d.same_phone[0].note}</p>}
      <h3 className="an-h2">Ochiq tekshiruvlar ({d.open_cases.length})</h3>
      {d.open_cases.map((c: any) => (
        <div key={c.id} className="scard">
          <div className="spread"><b>{c.display_name} ({c.code})</b><span className="pill">{STATUS_UZ[c.status]}</span></div>
          <div className="small muted">{REASON_UZ[c.reason_code]} · {c.orders} buyurtma · {new Date(c.created_at).toLocaleDateString('uz-UZ')}</div>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>{(NEXT[c.status] ?? []).map((to) => <button key={to} className="btn secondary sm" onClick={() => transition(c, to)}>{STATUS_UZ[to]}</button>)}</div>
        </div>
      ))}
    </section>
  );
}
