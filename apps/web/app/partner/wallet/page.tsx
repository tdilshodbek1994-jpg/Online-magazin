'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';
import PartnerPayouts from '../payouts/page';

const ORDER = ['available', 'hold', 'awaiting_cash', 'not_delivered', 'dispute', 'reversed'];
const HELP: Record<string, string> = {
  not_delivered: 'Mahsulot hali mijozga yetib bormagan.',
  awaiting_cash: 'Mijoz to‘ladi, kuryer pulni do‘konga topshirishi va solishtirilishi kutilmoqda.',
  hold: 'Qaytarish muddati tugashini kutyapmiz — shundan keyin yechish mumkin bo‘ladi.',
  dispute: 'Siz yozgan murojaat ko‘rib chiqilmoqda.',
  available: 'Komissiya tasdiqlangan va hisobingizga o‘tgan.',
  reversed: 'Buyurtma bekor bo‘lgan yoki qaytarilgan — sababi yonida yozilgan.',
};

/** Hamyon (V2 §10): not just numbers — every commission line says why it is (not yet) withdrawable. */
export default function Wallet() {
  const { lang } = useI18n();
  const [w, setW] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('all');
  const [shown, setShown] = useState(15);
  const [disp, setDisp] = useState({ order_id: '', subject: '', body: '' });
  const [dmsg, setDmsg] = useState<string | null>(null);
  const load = () => api('/partner/wallet').then(setW).catch((e) => setErr(e.code));
  useEffect(() => { void load(); try { const r = new URLSearchParams(location.search).get('reason'); if (r) { setFilter(r); setTimeout(() => document.getElementById('lines')?.scrollIntoView({ behavior: 'smooth' }), 400); } } catch {} }, []);
  const groups = (w?.groups ?? []).slice().sort((a: any, b: any) => ORDER.indexOf(a.reason) - ORDER.indexOf(b.reason));
  const lines = (w?.lines ?? []).filter((l: any) => filter === 'all' || l.reason === filter);
  return (
    <>
      <h1>Hamyon</h1>
      {err && <div className="notice" role="alert">{err}</div>}
      {w && (
        <>
          <section className="balance-card">
            <div className="bc-main"><span>Yechish mumkin</span><b>{som(w.balances.available_minor)}</b></div>
            <div className="bc-row">
              <button type="button" className="bc-link" onClick={() => setFilter('not_delivered')}><span>Yo‘lda (taxminiy) ›</span><b>{som(w.balances.estimated_minor)}</b></button>
              <button type="button" className="bc-link" onClick={() => setFilter('hold')}><span>Tekshiruvda ›</span><b>{som(w.balances.pending_minor)}</b></button>
              <div><span>To‘langan</span><b>{som(w.balances.paid_minor)}</b></div>
            </div>
            <a href="#yechish" className="btn bc-btn">Pul yechish</a>
          </section>
          {w.debt && (
            <div className="notice" role="note"><b>Tuzatish (qarz): {som(w.debt.amount_minor)}.</b> {w.debt.explanation}.
              {w.debt.sources?.length > 0 && <ul className="small">{w.debt.sources.map((s: any, i: number) => <li key={i}>{som(s.amount_minor)} — {s.reason ?? s.source_type}</li>)}</ul>}
            </div>
          )}

          <h2>Komissiya qayerda turibdi</h2>
          <div className="reason-grid">
            {groups.map((g: any) => (
              <button key={g.reason} type="button" className={`reason-card r-${g.reason} ${filter === g.reason ? 'on' : ''}`} aria-pressed={filter === g.reason} onClick={() => { setFilter(filter === g.reason ? 'all' : g.reason); setShown(15); }}>
                <span>{g.label}</span><b>{som(g.amount_minor)}</b><small>{g.count} ta · {HELP[g.reason] ?? ''}</small>
                {g.reason === 'available' && <small className="avail-split">Shundan: to‘langan {som(w.balances.paid_minor)} · so‘rovda {som(w.balances.reserved_minor)} · <b>yechish mumkin {som(w.balances.available_minor)}</b></small>}
              </button>
            ))}
            {groups.length === 0 && <div className="empty">Hali komissiya yo‘q. <Link href="/partner/new">Birinchi buyurtmani kiriting</Link> yoki <Link href="/partner/market">mahsulot tanlang</Link>.</div>}
          </div>

          {lines.length > 0 && (
            <div className="slist" id="lines">
              {lines.slice(0, shown).map((l: any) => (
                <Link key={l.id} href={`/partner/orders/${l.order_id}`} className="scard">
                  <div className="spread"><b>{l.masked_number} · {pick(l.product, lang)} × {l.qty}</b><b className={l.reason === 'reversed' ? 'no-t' : 'ok-t'}>{som(l.target_minor)}</b></div>
                  <div className="small"><span className={`pill r-${l.reason}`}>{l.reason_label}</span>
                    {l.reason === 'hold' && l.available_after && <span className="muted"> · {new Date(l.available_after).toLocaleDateString('uz-UZ')} da ochiladi</span>}
                    {l.reversed_reason && <span className="muted"> · sabab: {l.reversed_reason}</span>}
                  </div>
                </Link>
              ))}
              {lines.length > shown && <button className="btn secondary full" onClick={() => setShown(shown + 30)}>Yana ko‘rsatish ({lines.length - shown} ta qoldi)</button>}
            </div>
          )}

          <section className="card" id="murojaat">
            <h2>Komissiya bo‘yicha murojaat</h2>
            <p className="muted small">Hisob noto‘g‘ri tuyulsa, buyurtmani tanlab yozing — javob shu yerda va Telegram’da keladi.</p>
            {dmsg && <div className="notice" role="status">{dmsg}</div>}
            <label htmlFor="dord">Buyurtma</label>
            <select id="dord" value={disp.order_id} onChange={(e) => setDisp({ ...disp, order_id: e.target.value })}>
              <option value="">— umumiy savol —</option>
              {[...new Map((w.lines ?? []).map((l: any) => [l.order_id, l.masked_number])).entries()].map(([id, n]) => <option key={id as string} value={id as string}>{n as string}</option>)}
            </select>
            <label htmlFor="dsub">Mavzu</label><input id="dsub" value={disp.subject} onChange={(e) => setDisp({ ...disp, subject: e.target.value })} />
            <label htmlFor="dbody">Xabar</label><textarea id="dbody" rows={3} value={disp.body} onChange={(e) => setDisp({ ...disp, body: e.target.value })} />
            <button className="btn secondary" disabled={disp.subject.trim().length < 3 || disp.body.trim().length < 3} onClick={async () => {
              setDmsg(null);
              try { await api('/partner/disputes', { method: 'POST', body: { ...(disp.order_id ? { order_id: disp.order_id } : {}), subject: disp.subject.trim(), body: disp.body.trim() } }); setDisp({ order_id: '', subject: '', body: '' }); setDmsg('Murojaat yuborildi'); void load(); } catch (e: any) { setDmsg(e.code ?? 'ERROR'); }
            }}>Yuborish</button>
          </section>
        </>
      )}
      <div id="yechish" className="wallet-payouts"><PartnerPayouts /></div>
    </>
  );
}
