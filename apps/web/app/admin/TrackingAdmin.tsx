'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errText } from '@/lib/errors';
import { toast } from '@/lib/toast';

const REASON: Record<string, string> = {
  tracking_disabled: 'O‘chirilgan (egasi yoqmagan)', no_dataset: 'Dataset (Pixel ID) kiritilmagan', no_credentials: 'Meta kaliti ulanmagan (OAuth keyingi bosqichda)',
  adapter_not_connected: 'Meta adapteri hali ulanmagan', no_consent: 'Mijoz rozilik bermagan', consent_withdrawn: 'Mijoz rozilikni qaytarib oldi',
  outside_provider_window: 'Kech qoldi — muddatdan o‘tgan', test_event_in_production: 'Test hodisa — productionga yuborilmaydi', timeout: 'Javob kelmadi (noma’lum)',
};
const STATUS: Record<string, string> = { internal: 'Ichki', pending: 'Navbatda', blocked: 'To‘xtatilgan', sent: 'Yuborildi', rejected: 'Rad etildi', unknown: 'Noma’lum', expired: 'Muddati o‘tgan', suppressed: 'Yuborilmaydi' };
const r = (x: string | null) => (x ? REASON[x] ?? x : '—');

/** Admin «Pixel/CAPI diagnostikasi»: readiness, counts, event dictionary, recent events. Owner sets the single dataset. */
export function TrackingAdmin() {
  const [h, setH] = useState<any>(null);
  const [ds, setDs] = useState('');
  const load = useCallback(() => { api('/admin/tracking/health').then((x) => { setH(x); setDs(x.connection.dataset_id ?? ''); }).catch((e) => toast(errText(e), 'err')); }, []);
  useEffect(load, [load]);
  if (!h) return null;
  const c = h.connection;
  const save = async (body: any) => { try { setH(await api('/admin/tracking/settings', { method: 'PUT', body })); toast('✓ Saqlandi'); } catch (e: any) { toast(e.code === 'OWNER_APPROVAL_REQUIRED' ? 'Faqat egasi.' : errText(e), 'err'); } };
  return (
    <details className="card pp-more" style={{ marginTop: 12 }}>
      <summary>📡 Pixel / CAPI diagnostikasi — {c.state === 'ready' ? '✅ tayyor' : `⛔ ${r(c.blocked_reason)}`}</summary>
      <p className="muted small">Rozilik bo‘lmasa hech narsa yuborilmaydi. Lead — buyurtma so‘rovi; Purchase — faqat to‘lov olingan (naqd: yetkazildi + kassaga topshirildi) savdo. Qaytarishda manfiy Purchase yuborilmaydi. Bu raqamlar ichki hisob-kitob emas.</p>
      <div className="tr-grid">{['pending', 'blocked', 'sent', 'rejected', 'unknown', 'suppressed', 'expired', 'internal'].map((k) => <div key={k} className="tile"><b>{h.by_status[k] ?? 0}</b><span className="small muted">{STATUS[k]}</span></div>)}</div>
      <p className="small">Oxirgi muvaffaqiyat: {h.last_success_at ? new Date(h.last_success_at).toLocaleString('uz') : 'hali yo‘q'}{h.last_rejection ? ` · Oxirgi rad: ${r(h.last_rejection.reason)}` : ''}</p>
      <div className="tr-form">
        <label htmlFor="tr-ds">Dataset (Pixel) ID — do‘konning bitta asosiy dataseti</label><input id="tr-ds" inputMode="numeric" value={ds} onChange={(e) => setDs(e.target.value.replace(/\D/g, '').slice(0, 20))} placeholder="masalan 123456789012" />
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}><button className="btn sm" disabled={ds.length > 0 && ds.length < 6} onClick={() => save({ dataset_id: ds || null })}>Saqlash (egasi)</button>
        <button className="btn secondary sm" onClick={() => save({ enabled: !c.enabled })}>{c.enabled ? 'O‘chirish' : 'Yoqish'} (egasi)</button></div>
      </div>
      <p className="small muted">Meta kaliti bu yerda kiritilmaydi — keyingi bosqichda egasi Meta orqali (OAuth) ulaydi. Kalit: {c.has_credentials ? 'ulangan' : 'yo‘q'} · Hodisalar lug‘ati {c.mapping_version} · Rozilik matni {c.consent_policy_version}</p>
      <h3 className="small">Hodisalar lug‘ati</h3>
      <table className="tr-table"><tbody>{h.dictionary.map((d: any) => <tr key={d.internal_event}><td>{d.internal_event}</td><td><b>{d.meta_event ?? 'ichki'}</b></td><td className="muted small">{d.value_rule}</td></tr>)}</tbody></table>
      <h3 className="small">So‘nggi hodisalar</h3>
      <table className="tr-table"><tbody>{h.recent.length ? h.recent.map((e: any) => <tr key={e.event_id}><td>{e.meta_event ?? e.internal_event}</td><td>{STATUS[e.status] ?? e.status}</td><td className="muted">{r(e.blocked_reason)}</td><td className="muted">{new Date(e.event_time).toLocaleString('uz')}</td></tr>) : <tr><td className="muted">Hali hodisa yo‘q</td></tr>}</tbody></table>
    </details>
  );
}
