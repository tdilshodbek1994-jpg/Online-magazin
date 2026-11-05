'use client';
import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { Async } from '@/components/Header';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';
import { BUCKET_LABEL } from '../../shared';
import { PartnerRequests } from './Requests';

const STATUS_TEXT: Record<string, string> = {
  awaiting_confirmation: 'Tasdiqlash kutilmoqda', confirmed: 'Tasdiqlandi', cancelled: 'Bekor qilindi', completed: 'Yakunlandi',
  pending: 'Kutilmoqda', packed: 'Qadoqlandi', shipped: 'Jo‘natildi', delivered: 'Yetkazildi', returned: 'Qaytarildi', failed: 'Yetkazilmadi',
  paid: 'To‘landi', unpaid: 'To‘lanmagan', picking: 'Yig‘ilmoqda', picked: 'Yig‘ildi', unfulfilled: 'Kutilmoqda', refunded: 'Qaytarildi',
};
const MONEY: Record<string, string> = { external: 'Yangi', estimated: 'Taxminiy', pending: 'Tekshiruvda', available: 'Yechish mumkin', reserved: 'So‘rovda', paid: 'To‘langan', debt: 'Qarz' };
const MONEY_REASON: Record<string, string> = { order_created: 'buyurtma yaratildi', delivered_and_settled: 'yetkazildi va pul tushdi', hold_elapsed: 'qaytarish muddati tugadi', order_cancelled: 'buyurtma bekor bo‘ldi' };
const DIM: Record<string, string> = { commercial: 'Buyurtma', fulfillment: 'Yetkazish', payment: 'To‘lov', refund: 'Qaytarish' };

const CALL: Record<string, string> = { confirmed: 'tasdiqladi', no_answer: 'mijoz javob bermadi', rejected: 'mijoz rad etdi', wrong_data: 'ma’lumot noto‘g‘ri', call_later: 'keyinroq qo‘ng‘iroq so‘radi' };
const tm = (iso: string) => new Date(iso).toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
function gap(a: string | null, b: string | null) {
  if (!a || !b) return '';
  const m = Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60000));
  return m < 1 ? 'darhol' : m < 60 ? `${m} daq o‘tib` : m < 1440 ? `${Math.floor(m / 60)} soat ${m % 60} daq o‘tib` : `${Math.floor(m / 1440)} kun ${Math.floor((m % 1440) / 60)} soat o‘tib`;
}

/** Order milestones: received → operator call(s) → accepted → shipped → delivered (→ paid). Times in Tashkent. */
function Milestones({ m }: { m: any }) {
  if (!m) return null;
  const lastCall = m.calls.length ? m.calls[m.calls.length - 1].created_at : null;
  const rows: { icon: string; title: string; at: string | null; sub?: string; prev?: string | null; bad?: boolean }[] = [
    { icon: '🛒', title: 'Buyurtma tushdi', at: m.received_at },
    ...(m.calls.length ? m.calls.map((c: any, i: number) => ({ icon: '📞', title: `Operator${c.operator ? ` ${c.operator}` : ''} gaplashdi`, at: c.created_at, sub: CALL[c.outcome] ?? c.outcome, prev: i === 0 ? m.received_at : m.calls[i - 1].created_at, bad: c.outcome === 'rejected' }))
      : [{ icon: '📞', title: `Operator${m.operator ? ` ${m.operator}` : ''} qo‘ng‘irog‘i`, at: null }]),
    { icon: '✅', title: 'Tasdiqlandi', at: m.accepted_at, prev: lastCall ?? m.received_at },
    { icon: '🚚', title: 'Yetkazishga chiqarildi', at: m.shipped_at, prev: m.accepted_at },
    { icon: '📦', title: 'Mijozga yetib bordi', at: m.delivered_at, prev: m.shipped_at },
  ];
  if (m.paid_at) rows.push({ icon: '💵', title: 'Pul do‘konga tushdi', at: m.paid_at, prev: m.delivered_at });
  if (m.cancelled_at) rows.push({ icon: '❌', title: 'Bekor qilindi', at: m.cancelled_at, bad: true });
  if (m.returned_at) rows.push({ icon: '↩️', title: 'Qaytarildi / yetkazilmadi', at: m.returned_at, bad: true });
  return (
    <section className="card ms">
      <b>⏱ Buyurtma yo‘li</b>
      <ol className="ms-list">
        {rows.map((r, i) => (
          <li key={i} className={r.at ? (r.bad ? 'bad' : 'done') : 'wait'}>
            <span className="ms-ico" aria-hidden>{r.icon}</span>
            <div className="ms-body">
              <div className="ms-row"><b>{r.title}</b><span className="ms-time">{r.at ? tm(r.at) : 'kutilmoqda'}</span></div>
              {(r.sub || (r.at && r.prev)) && <div className="small muted">{[r.sub, r.at && r.prev ? gap(r.prev, r.at) : ''].filter(Boolean).join(' · ')}</div>}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

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
  const off = d && (d.bucket === 'cancelled' || d.bucket === 'returned');
  return (
    <Async loading={!d && !err} error={err}>
      {d && (
        <div className="passport pp2">
          <Link href="/partner/orders" className="see-all">← Buyurtmalar</Link>

          {/* Hero: what was sold, its state, my bonus, what happens now */}
          <section className={`pp-hero b-${d.bucket}`}>
            <div className="pp-hero-top">
              <div className="pp-thumb">{d.commission.lines[0]?.image ? <img src={d.commission.lines[0].image} alt="" /> : <span aria-hidden>🛍️</span>}</div>
              <div className="pp-hero-txt">
                <div className="pp-num">Buyurtma {d.masked_number}</div>
                <h1>{d.commission.lines.length ? d.commission.lines.map((l: any) => `${pick(l.product, lang)}${l.qty > 1 ? ` × ${l.qty}` : ''}`).join(', ') : 'Buyurtma'}</h1>
                <span className={`pill b-${d.bucket}`}>{BUCKET_LABEL[d.bucket]}</span>
              </div>
            </div>
            <div className="pp-bonus2"><span>Sizning bonusingiz</span><b className={off ? 'no-t' : ''}>{som(d.commission.total_minor)}</b></div>
            {off && <div className="notice">{d.bucket === 'cancelled' ? (d.confirmation_status === 'expired' ? 'Mijoz belgilangan vaqtda tasdiqlamadi — buyurtma bekor bo‘ldi.' : d.confirmation_status === 'rejected' ? 'Mijoz buyurtmani rad etdi.' : 'Buyurtma bekor qilindi.') : 'Mahsulot qaytarildi.'}</div>}
            {d.explain && <div className="pp-now2"><span aria-hidden>💡</span><div><b>{d.explain.what}</b><div>{d.explain.next}</div></div></div>}
            <div className="pp-meta"><span>👤 {d.customer}</span><span>📍 {d.district ?? '—'}</span><span>🕒 {tm(d.created_at)}</span></div>
          </section>

          <Milestones m={d.milestones} />

          {/* Settlement: clean table */}
          <details className="card pp-sec pp-fold">
            <summary><span className="pp-fi" aria-hidden>🧾</span><span className="pp-ft"><span className="pp-h">Bonus hisob-kitobi</span><span className="pp-fs">{d.commission.lines.length ? <><b className="ok-t">{som(d.commission.lines.reduce((t: bigint, l: any) => t + BigInt(l.target_minor ?? 0), 0n).toString())}</b> · {d.commission.lines.length} ta mahsulot</> : 'Bonus yo‘q'}</span></span></summary>
            {d.commission.lines.length === 0 ? <p className="muted small">Bu buyurtmada bonus yo‘q (mahsulot uchun qoida belgilanmagan yoki buyurtma tasdiqlanmagan).</p> : d.commission.lines.map((l: any) => (
              <div key={l.id} className="pp-line">
                <div className="pp-line-h"><b>{pick(l.product, lang)}</b><span className={`pill r-${l.reason}`}>{l.reason_label}</span></div>
                <dl className="pp-dl">
                  <div><dt>Soni</dt><dd>{l.qty} dona{l.returned_qty ? ` (qaytdi ${l.returned_qty})` : ''}</dd></div>
                  <div><dt>Narx</dt><dd>{som(l.line_gross_minor)}</dd></div>
                  <div><dt>Komissiya qoidasi</dt><dd>{ruleText(l.rule_snapshot)}</dd></div>
                  {l.available_after && l.state === 'pending' && <div><dt>Yechish mumkin bo‘ladi</dt><dd>{new Date(l.available_after).toLocaleDateString('uz-UZ')}</dd></div>}
                  <div className="tot"><dt>Bonus</dt><dd className={l.state === 'reversed' ? 'no-t' : 'ok-t'}>{som(l.target_minor)}</dd></div>
                </dl>
              </div>
            ))}
            <p className="pp-foot">🔒 Foiz buyurtma vaqtida qotirilgan — keyin o‘zgarsa ham bu buyurtmaga ta’sir qilmaydi.</p>
          </details>

          <details className="card pp-sec pp-fold">
            <summary><span className="pp-fi" aria-hidden>🔗</span><span className="pp-ft"><span className="pp-h">Buyurtma qayerdan</span><span className="pp-fs">{d.source}</span></span></summary>
            <dl className="pp-dl">
              <div><dt>Manba</dt><dd>{d.source}</dd></div>
              <div><dt>Nega sizniki</dt><dd>{d.attribution.reason_label}</dd></div>
              <div><dt>Mijoz</dt><dd>{d.customer} · {d.customer_phone}</dd></div>
              {d.contact_time_note && <div><dt>Aloqa vaqti</dt><dd>{d.contact_time_note}</dd></div>}
            </dl>
          </details>

          {d.entries.length > 0 && (
            <details className="card pp-sec pp-fold">
              <summary><span className="pp-fi" aria-hidden>💰</span><span className="pp-ft"><span className="pp-h">Bonus harakatlari</span><span className="pp-fs">Pul harakatlari tarixi</span></span><span className="pp-count">{d.entries.length}</span></summary>
              <ul className="pp-moves">
                {d.entries.map((e: any, i: number) => (
                  <li key={i}><div><b>{MONEY[e.from_bucket] ?? e.from_bucket} → {MONEY[e.to_bucket] ?? e.to_bucket}</b><div className="small muted">{e.reason ? (MONEY_REASON[e.reason] ?? e.reason) : ''}{e.created_at ? ` · ${tm(e.created_at)}` : ''}</div></div><b className="ok-t">{som(e.amount_minor)}</b></li>
                ))}
              </ul>
            </details>
          )}

          <details className="card pp-sec pp-fold pp-ask">
            <summary><span className="pp-fi" aria-hidden>✉️</span><span className="pp-ft"><span className="pp-h">Operatorga yozish</span><span className="pp-fs">Savol yoki muammo bo‘lsa yozing</span></span></summary>
            <PartnerRequests orderId={id} />
          </details>
        </div>
      )}
    </Async>
  );
}
