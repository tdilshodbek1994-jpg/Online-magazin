'use client';
import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { Async } from '@/components/Header';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';
import { BUCKET_LABEL } from '../../shared';
import { PartnerRequests } from './Requests';

const STEPS: [string, string][] = [['new', 'Qabul qilindi'], ['accepted', 'Tasdiqlandi'], ['shipping', 'Yo‘lda'], ['delivered', 'Yetkazildi']];
const STATUS_TEXT: Record<string, string> = {
  awaiting_confirmation: 'Tasdiqlash kutilmoqda', confirmed: 'Tasdiqlandi', cancelled: 'Bekor qilindi', completed: 'Yakunlandi',
  pending: 'Kutilmoqda', packed: 'Qadoqlandi', shipped: 'Jo‘natildi', delivered: 'Yetkazildi', returned: 'Qaytarildi', failed: 'Yetkazilmadi',
  paid: 'To‘landi', unpaid: 'To‘lanmagan', picking: 'Yig‘ilmoqda', picked: 'Yig‘ildi', unfulfilled: 'Kutilmoqda', refunded: 'Qaytarildi',
};
const MONEY: Record<string, string> = { external: 'Yangi', estimated: 'Taxminiy', pending: 'Tekshiruvda', available: 'Yechish mumkin', reserved: 'So‘rovda', paid: 'To‘langan', debt: 'Qarz' };
const MONEY_REASON: Record<string, string> = { order_created: 'buyurtma yaratildi', delivered_and_settled: 'yetkazildi va pul tushdi', hold_elapsed: 'qaytarish muddati tugadi', order_cancelled: 'buyurtma bekor bo‘ldi' };
const DIM: Record<string, string> = { commercial: 'Buyurtma', fulfillment: 'Yetkazish', payment: 'To‘lov', refund: 'Qaytarish' };

function ruleText(r: any): string {
  if (!r) return '—';
  if (r.kind === 'percent' && r.rate_bps != null) return `Narxdan ${(Number(r.rate_bps) / 100).toLocaleString('uz-UZ')}%`;
  if (r.kind === 'fixed_per_unit' && r.fixed_minor != null) return `Har dona uchun ${som(String(r.fixed_minor))}`;
  return r.kind ?? '—';
}

/** Sotuv pasporti (V2 §09): where the order came from, why it is yours, how the commission was computed, where it is now. */
export default function SalesPassport({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { lang } = useI18n();
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  useEffect(() => { api(`/partner/orders/${id}/passport`).then(setD).catch(setErr); }, [id]);
  const stepIdx = d ? STEPS.findIndex(([k]) => k === d.bucket) : -1;
  const off = d && (d.bucket === 'cancelled' || d.bucket === 'returned');
  return (
    <Async loading={!d && !err} error={err}>
      {d && (
        <div className="passport">
          <Link href="/partner/orders" className="see-all">← Buyurtmalar</Link>
          <div className="spread"><h1>Sotuv pasporti · {d.masked_number}</h1><span className={`pill b-${d.bucket}`}>{BUCKET_LABEL[d.bucket]}</span></div>

          {off ? <div className="notice">{d.bucket === 'cancelled' ? (d.confirmation_status === 'expired' ? 'Mijoz belgilangan vaqtda tasdiqlamadi — buyurtma bekor bo‘ldi.' : d.confirmation_status === 'rejected' ? 'Mijoz buyurtmani rad etdi.' : 'Buyurtma bekor qilindi.') : 'Mahsulot qaytarildi.'}</div> : (
            <ol className="steps" aria-label="Buyurtma bosqichlari">
              {STEPS.map(([k, l], i) => <li key={k} className={i < stepIdx ? 'done' : i === stepIdx ? 'now' : ''} aria-current={i === stepIdx ? 'step' : undefined}>{l}</li>)}
            </ol>
          )}
          {d.explain && (
            <section className={`explain-box t-${d.explain.whose_turn}`} aria-label="Nima bo‘ldi va keyingi qadam">
              <div><b>Nima bo‘ldi:</b> {d.explain.what}</div>
              <div><b>Navbat:</b> {({ partner: 'Sizda', customer: 'Mijozda', shop: 'Do‘konda', none: 'Hech kimda — kutish' } as Record<string, string>)[d.explain.whose_turn]}</div>
              <div><b>Keyingi qadam:</b> {d.explain.next}</div>
            </section>
          )}

          <section className="card">
            <h2>Kimniki va nega</h2>
            <div className="kv"><span>Manba</span><b>{d.source}</b></div>
            <div className="kv"><span>Sabab</span><b>{d.attribution.reason_label}</b></div>
            <div className="kv"><span>Mijoz</span><b>{d.customer} · {d.customer_phone}</b></div>
            <div className="kv"><span>Hudud</span><b>{d.district ?? '—'}</b></div>
            {d.contact_time_note && <div className="kv"><span>Aloqa vaqti</span><b>{d.contact_time_note}</b></div>}
            <div className="kv"><span>Yaratilgan</span><b>{new Date(d.created_at).toLocaleString('uz-UZ', { dateStyle: 'short', timeStyle: 'short' })}</b></div>
          </section>

          <section className="card">
            <h2>Komissiya qanday hisoblandi</h2>
            {d.commission.lines.length === 0 && <p className="muted">Bu buyurtmada komissiya yo‘q (mahsulot uchun qoida belgilanmagan yoki buyurtma tasdiqlanmagan).</p>}
            {d.commission.lines.map((l: any) => (
              <div key={l.id} className="comm-line">
                <div className="spread"><b>{pick(l.product, lang)} × {l.qty}{l.returned_qty ? ` (qaytdi: ${l.returned_qty})` : ''}</b><b className={l.state === 'reversed' ? 'no-t' : 'ok-t'}>{som(l.target_minor)}</b></div>
                <div className="small">Asos: {som(l.line_gross_minor)} · Qoida: {ruleText(l.rule_snapshot)}</div>
                <div className="small"><span className={`pill r-${l.reason}`}>{l.reason_label}</span>{l.available_after && l.state === 'pending' ? <span className="muted"> · ochiladi: {new Date(l.available_after).toLocaleDateString('uz-UZ')}</span> : null}</div>
              </div>
            ))}
            <div className="sum-row total"><span>Jami komissiya</span><b>{som(d.commission.total_minor)}</b></div>
            <p className="muted small">Qoida buyurtma vaqtida qotirilgan: keyin foiz o‘zgarsa ham bu buyurtmaga ta’sir qilmaydi.</p>
          </section>

          <PartnerRequests orderId={id} />
          <section className="card">
            <h2>Tarix</h2>
            <ul className="timeline">
              {d.timeline.map((e: any, i: number) => (
                <li key={i}><b>{DIM[e.dimension] ?? e.dimension}: {STATUS_TEXT[e.to_status] ?? e.to_status}</b><span className="muted small"> · {new Date(e.created_at).toLocaleString('uz-UZ', { dateStyle: 'short', timeStyle: 'short' })}</span></li>
              ))}
              {d.entries.map((e: any, i: number) => <li key={`m${i}`} className="money"><b>💰 {som(e.amount_minor)}: {MONEY[e.from_bucket] ?? e.from_bucket} → {MONEY[e.to_bucket] ?? e.to_bucket}</b>{e.reason && <span className="muted small"> · {MONEY_REASON[e.reason] ?? e.reason}</span>}</li>)}
            </ul>
          </section>
          <p className="muted small">Savol bo‘lsa, <Link href="/partner/wallet#murojaat">Hamyon → Murojaat</Link> orqali shu buyurtma bo‘yicha yozing.</p>
        </div>
      )}
    </Async>
  );
}
