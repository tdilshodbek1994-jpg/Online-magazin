'use client';
import { useCallback, useEffect, useState } from 'react';
import { Async } from '@/components/Header';
import { api, som } from '@/lib/api';
import { usePartnerMe } from '../shared';

const BUCKETS: [string, string][] = [['estimated_minor', 'Taxminiy'], ['pending_minor', 'Kutilmoqda'], ['available_minor', 'Yechish mumkin'], ['reserved_minor', "To'lov so'rovida"], ['paid_minor', "To'langan"], ['debt_minor', 'Tuzatish (qarz)']];
const BUCKET_NAME: Record<string, string> = { estimated: 'Taxminiy', pending: 'Kutilmoqda', available: 'Yechish mumkin', reserved: "So'rovda", paid: "To'langan", debt: 'Qarz', void: '—', external: 'Tashqi' };
const PAYOUT_STATUS: Record<string, string> = { requested: 'So‘rov yuborildi', approved: 'Tasdiqlandi', processing: 'O‘tkazilmoqda', processing_unknown: 'Tekshirilmoqda', paid: 'To‘landi', rejected: 'Rad etildi' };

export default function PartnerPayouts() {
  const { me, error, reload } = usePartnerMe();
  const [payouts, setPayouts] = useState<any[]>([]);
  const [ledger, setLedger] = useState<any[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [d, setD] = useState({ holder: '', number: '' });
  const [amt, setAmt] = useState('');
  const [ledgerAll, setLedgerAll] = useState(false);
  const load = useCallback(async () => {
    const [p, l] = await Promise.all([api('/partner/payouts').catch(() => ({ items: [] })), api('/partner/ledger').catch(() => ({ items: [] }))]);
    setPayouts(p.items); setLedger(l.items);
  }, []);
  useEffect(() => { if (me) void load(); }, [me, load]);
  const act = async (fn: () => Promise<any>, ok: string) => { setMsg(null); try { await fn(); setMsg(ok); await reload(); await load(); } catch (e: any) { setMsg(e.code ?? 'ERROR'); } };
  return (
    <Async loading={me === undefined && !error} error={error} onRetry={reload}>
      {me === null && <p className="notice">Hamkor bo‘lish uchun <a href="/partner">ariza yuboring</a>.</p>}
      {me && (
        <>
          <h1>To‘lov</h1>
          {msg && <div className="notice" role="status">{msg}</div>}
          <div className="bal-grid">{BUCKETS.map(([k, label]) => <div key={k} className={`card bal ${k === 'available_minor' ? 'bal-main' : ''}`}><span className="muted">{label}</span><b>{som(me.balances[k])}</b></div>)}</div>
          <p className="muted small">Taxminiy → buyurtma yetkazilgach «Kutilmoqda» → to‘lov kassaga tushib, kutish muddati o‘tgach «Yechish mumkin».</p>

          <section className="card" style={{ marginTop: 12 }}>
            <h2>Pul yechish</h2>
            <p>Karta: {me.payout_destination ? <><b>{me.payout_destination.masked}</b> {me.payout_destination.verified ? <span className="pill b-delivered">✓ tasdiqlangan</span> : <span className="pill b-shipping">tasdiq kutilmoqda</span>}</> : <span className="muted">kiritilmagan</span>}</p>
            <div className="form-grid">
              <div><label htmlFor="dh">Karta egasi</label><input id="dh" value={d.holder} onChange={(e) => setD({ ...d, holder: e.target.value })} /></div>
              <div><label htmlFor="dnum">Karta raqami</label><input id="dnum" inputMode="numeric" value={d.number} onChange={(e) => setD({ ...d, number: e.target.value.replace(/\D/g, '') })} /></div>
              <button className="btn secondary" onClick={() => act(() => api('/partner/payout-destination', { method: 'PUT', body: { type: 'card', holder: d.holder, number: d.number } }), 'Karta saqlandi — tasdiqlanishini kuting')}>Kartani saqlash</button>
            </div>
            <div className="form-grid" style={{ marginTop: 12 }}>
              <div><label htmlFor="am">Summa (so‘m)</label><input id="am" inputMode="numeric" value={amt} onChange={(e) => setAmt(e.target.value.replace(/\D/g, ''))} placeholder={`mavjud: ${som(me.balances.available_minor)}`} /></div>
              <button className="btn" disabled={!amt} onClick={() => act(() => api('/partner/payouts', { method: 'POST', idem: crypto.randomUUID(), body: { amount_minor: String(BigInt(amt) * 100n) } }), 'So‘rov yuborildi')}>So‘rov yuborish</button>
            </div>
          </section>

          <section className="card" style={{ marginTop: 12 }}>
            <h2>To‘lovlar tarixi</h2>
            {payouts.length === 0 ? <p className="muted">Hali to‘lov so‘rovi yo‘q</p> : (
              <div className="table-wrap" tabIndex={0} role="region" aria-label="Jadval"><table><thead><tr><th>Sana</th><th>Summa</th><th>Holat</th><th>Izoh</th></tr></thead><tbody>
                {payouts.map((p) => <tr key={p.id}><td>{new Date(p.created_at).toLocaleDateString('uz-UZ')}</td><td>{som(p.amount_minor)}</td><td>{PAYOUT_STATUS[p.status] ?? p.status}</td><td>{p.paid_reference ?? p.reject_reason ?? ''}</td></tr>)}
              </tbody></table></div>
            )}
          </section>

          <section className="card" style={{ marginTop: 12 }}>
            <h2>Balans tarixi</h2>
            {ledger.length === 0 ? <p className="muted">Ma’lumot topilmadi</p> : (
              <div className="table-wrap" tabIndex={0} role="region" aria-label="Jadval"><table><thead><tr><th>Sana</th><th>Harakat</th><th>Summa</th><th>Sabab</th></tr></thead><tbody>
                {(ledgerAll ? ledger : ledger.slice(0, 20)).map((e) => <tr key={e.id}><td>{new Date(e.created_at).toLocaleDateString('uz-UZ')}</td><td>{BUCKET_NAME[e.from_bucket] ?? e.from_bucket} → {BUCKET_NAME[e.to_bucket] ?? e.to_bucket}</td><td>{som(e.amount_minor)}</td><td className="muted small">{e.reason ?? e.source_type}</td></tr>)}
              </tbody></table></div>
            )}
            {!ledgerAll && ledger.length > 20 && <button className="btn secondary full mt8" onClick={() => setLedgerAll(true)}>Hammasini ko‘rsatish ({ledger.length})</button>}
          </section>
        </>
      )}
    </Async>
  );
}
