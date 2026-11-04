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
          <div className="spread"><h1>Buyurtma {d.masked_number}</h1><span className={`pill b-${d.bucket}`}>{BUCKET_LABEL[d.bucket]}</span></div>

          {off ? <div className="notice">{d.bucket === 'cancelled' ? (d.confirmation_status === 'expired' ? 'Mijoz belgilangan vaqtda tasdiqlamadi — buyurtma bekor bo‘ldi.' : d.confirmation_status === 'rejected' ? 'Mijoz buyurtmani rad etdi.' : 'Buyurtma bekor qilindi.') : 'Mahsulot qaytarildi.'}</div> : (
            <ol className="steps" aria-label="Buyurtma bosqichlari">
              {STEPS.map(([k, l], i) => <li key={k} className={i < stepIdx ? 'done' : i === stepIdx ? 'now' : ''} aria-current={i === stepIdx ? 'step' : undefined}>{l}</li>)}
            </ol>
          )}
          {/* Short by default (user: "juda uzun, tushunarsiz"): what was sold, my bonus, what happens now. Details fold away. */}
          <section className="card pp-sum">
            <div className="pp-prod">{d.commission.lines.length ? d.commission.lines.map((l: any) => `${pick(l.product, lang)}${l.qty > 1 ? ` × ${l.qty}` : ''}`).join(', ') : '—'}</div>
            <div className="pp-bonus"><span>Sizning bonusingiz</span><b className={d.bucket === 'cancelled' || d.bucket === 'returned' ? 'no-t' : 'ok-t'}>{som(d.commission.total_minor)}</b></div>
            {d.explain && <p className="pp-now">{d.explain.what} {d.explain.next}</p>}
            <div className="small muted">{d.customer} · {d.district ?? '—'} · {new Date(d.created_at).toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
          </section>

          <details className="card pp-more">
            <summary>Batafsil: manba va bonus hisobi</summary>
            <div className="kv"><span>Manba</span><b>{d.source}</b></div>
            <div className="kv"><span>Nega sizniki</span><b>{d.attribution.reason_label}</b></div>
            <div className="kv"><span>Mijoz</span><b>{d.customer} · {d.customer_phone}</b></div>
            {d.contact_time_note && <div className="kv"><span>Aloqa vaqti</span><b>{d.contact_time_note}</b></div>}
            {d.commission.lines.length === 0 && <p className="muted small">Bu buyurtmada bonus yo‘q (mahsulot uchun qoida belgilanmagan yoki buyurtma tasdiqlanmagan).</p>}
            {d.commission.lines.map((l: any) => (
              <div key={l.id} className="comm-line">
                <div className="spread"><b>{pick(l.product, lang)} × {l.qty}{l.returned_qty ? ` (qaytdi: ${l.returned_qty})` : ''}</b><b className={l.state === 'reversed' ? 'no-t' : 'ok-t'}>{som(l.target_minor)}</b></div>
                <div className="small">Narx {som(l.line_gross_minor)} · {ruleText(l.rule_snapshot)} · <span className={`pill r-${l.reason}`}>{l.reason_label}</span>{l.available_after && l.state === 'pending' ? <span className="muted"> · ochiladi: {new Date(l.available_after).toLocaleDateString('uz-UZ')}</span> : null}</div>
              </div>
            ))}
            <p className="muted small">Foiz buyurtma vaqtida qotirilgan: keyin o‘zgarsa ham bu buyurtmaga ta’sir qilmaydi.</p>
          </details>

          <details className="card pp-more">
            <summary>Tarix ({d.timeline.length + d.entries.length})</summary>
            <ul className="timeline">
              {d.timeline.map((e: any, i: number) => (
                <li key={i}><b>{DIM[e.dimension] ?? e.dimension}: {STATUS_TEXT[e.to_status] ?? e.to_status}</b><span className="muted small"> · {new Date(e.created_at).toLocaleString('uz-UZ', { dateStyle: 'short', timeStyle: 'short' })}</span></li>
              ))}
              {d.entries.map((e: any, i: number) => <li key={`m${i}`} className="money"><b>💰 {som(e.amount_minor)}: {MONEY[e.from_bucket] ?? e.from_bucket} → {MONEY[e.to_bucket] ?? e.to_bucket}</b>{e.reason && <span className="muted small"> · {MONEY_REASON[e.reason] ?? e.reason}</span>}</li>)}
            </ul>
          </details>

          <details className="card pp-more pp-ask">
            <summary>✉️ Operatorga yozish</summary>
            <PartnerRequests orderId={id} />
          </details>
        </div>
      )}
    </Async>
  );
}
