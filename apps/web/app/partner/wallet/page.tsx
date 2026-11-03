'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';

/**
 * Hamyon — "Pulim qayerda?" in plain words. One big number (withdrawable) with one button, the card in one line,
 * commission lines as a short list with a status, the money history as sentences (no internal codes),
 * and the help form folded away. Same APIs as before; nothing about the money rules changed.
 */
const STATUS: Record<string, { label: string; help: string; cls: string }> = {
  available: { label: 'Yechish mumkin', help: 'Hisobingizga o‘tgan', cls: 'st-ok' },
  hold: { label: 'Qaytarish muddati', help: 'Yetkazildi, muddat tugashini kutyapmiz', cls: 'st-wait' },
  awaiting_cash: { label: 'Pul kutilmoqda', help: 'Kuryer pulni topshirishi kutilmoqda', cls: 'st-wait' },
  not_delivered: { label: 'Yo‘lda', help: 'Hali yetkazilmagan', cls: 'st-road' },
  dispute: { label: 'Murojaat', help: 'Siz yozgan murojaat ko‘rib chiqilmoqda', cls: 'st-wait' },
  reversed: { label: 'Bekor', help: 'Buyurtma bekor bo‘ldi yoki qaytarildi', cls: 'st-off' },
};
const ORDER = ['available', 'hold', 'awaiting_cash', 'not_delivered', 'dispute', 'reversed'];
const PAYOUT: Record<string, string> = { requested: 'So‘rov yuborildi', approved: 'Tasdiqlandi', processing: 'O‘tkazilmoqda', processing_unknown: 'Tekshirilmoqda', paid: 'To‘landi ✓', rejected: 'Rad etildi' };

/** Money history as a sentence (never internal bucket/reason codes). */
function story(e: any): { text: string; sign: '+' | '−' | '' } {
  const f = e.from_bucket, t = e.to_bucket, r = e.reason ?? '', s = e.source_type ?? '';
  if (s === 'payout' || s === 'payout_request') {
    if (f === 'available' && t === 'reserved') return { text: 'Pul yechish so‘rovi yuborildi', sign: '−' };
    if (f === 'reserved' && t === 'paid') return { text: 'Kartangizga to‘landi ✓', sign: '' };
    if (f === 'reserved' && t === 'available') return { text: 'So‘rov rad etildi — pul hisobingizga qaytdi', sign: '+' };
  }
  if (s === 'bonus' || s === 'bonus_rule' || s === 'contest_prize') return { text: s === 'contest_prize' ? 'Konkurs sovrini' : `Bonus${r ? `: ${r}` : ''}`, sign: '+' };
  if (s === 'penalty') return t === 'available' ? { text: 'Jarima bekor qilindi', sign: '+' } : { text: `Jarima${r ? `: ${r}` : ''}`, sign: '−' };
  if (s === 'penalty_cancel') return { text: 'Jarima bekor qilindi', sign: '+' };
  if (s === 'charity') return { text: 'Hayriya qutisiga', sign: '−' };
  if (r === 'order_created' || (f === 'external' && t === 'estimated')) return { text: 'Yangi buyurtma — komissiya yo‘lda', sign: '' };
  if (r === 'delivered_and_settled' || (f === 'estimated' && t === 'pending')) return { text: 'Yetkazildi, pul tushdi — qaytarish muddati kutilmoqda', sign: '' };
  if (r === 'hold_elapsed' || (f === 'pending' && t === 'available')) return { text: 'Muddat tugadi — yechish mumkin bo‘ldi', sign: '+' };
  if (t === 'external' || t === 'debt') return { text: r.includes('cancel') ? 'Buyurtma bekor bo‘ldi' : 'Buyurtma qaytarildi yoki tuzatildi', sign: '−' };
  return { text: 'Hisob o‘zgarishi', sign: '' };
}

export default function Wallet() {
  const { lang } = useI18n();
  const [w, setW] = useState<any>(null);
  const [me, setMe] = useState<any>(null);
  const [payouts, setPayouts] = useState<any[]>([]);
  const [ledger, setLedger] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('all');
  const [shown, setShown] = useState(8);
  const [histShown, setHistShown] = useState(10);
  const [amt, setAmt] = useState('');
  const [cardEdit, setCardEdit] = useState(false);
  const [card, setCard] = useState({ holder: '', number: '' });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [disp, setDisp] = useState({ order_id: '', subject: '', body: '' });
  const load = useCallback(() => {
    api('/partner/wallet').then(setW).catch((e) => setErr(e.code));
    api('/partner/me').then(setMe).catch(() => {});
    api('/partner/payouts').then((r) => setPayouts(r.items ?? [])).catch(() => {});
    api('/partner/ledger').then((r) => setLedger(r.items ?? [])).catch(() => {});
  }, []);
  useEffect(() => {
    load();
    try { const r = new URLSearchParams(location.search).get('reason'); if (r) { setFilter(r); setTimeout(() => document.getElementById('lines')?.scrollIntoView({ behavior: 'smooth' }), 500); } } catch {}
  }, [load]);
  const act = async (fn: () => Promise<any>, ok: string) => {
    setMsg(null);
    try { await fn(); setMsg({ ok: true, text: ok }); load(); } catch (e: any) {
      const m: Record<string, string> = { INSUFFICIENT_AVAILABLE: 'Bu summa yechish mumkin bo‘lgan puldan ko‘p', PAYOUT_BELOW_MINIMUM: 'Summa eng kam miqdordan kichik', PAYOUT_DESTINATION_NOT_VERIFIED: 'Karta hali tasdiqlanmagan' };
      setMsg({ ok: false, text: m[e.code] ?? 'Xatolik. Qayta urinib ko‘ring.' });
    }
  };
  if (err) return <div className="notice" role="alert">Ma’lumotni yuklab bo‘lmadi</div>;
  if (!w) return <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>;
  const b = w.balances;
  const groups: any[] = (w.groups ?? []).filter((g: any) => g.reason !== 'superseded').sort((a: any, c: any) => ORDER.indexOf(a.reason) - ORDER.indexOf(c.reason));
  const lines = (w.lines ?? []).filter((l: any) => filter === 'all' || l.reason === filter);
  const dest = me?.payout_destination;
  const canWithdraw = BigInt(b.available_minor) > 0n && dest?.verified;
  return (
    <div className="wal">
      <h1>Hamyon</h1>

      <section className="wal-hero">
        <span>Yechib olishingiz mumkin</span>
        <b>{som(b.available_minor)}</b>
        <div className="wal-sub">
          <button type="button" onClick={() => setFilter('not_delivered')}>🚚 Yo‘lda: <b>{som(b.estimated_minor)}</b></button>
          <button type="button" onClick={() => setFilter('hold')}>⏳ Kutilmoqda: <b>{som(b.pending_minor)}</b></button>
          {BigInt(b.reserved_minor) > 0n && <span>📤 So‘rovda: <b>{som(b.reserved_minor)}</b></span>}
          <span>✅ To‘langan: <b>{som(b.paid_minor)}</b></span>
        </div>
        {w.debt && <div className="wal-debt">Tuzatish (qarz): {som(w.debt.amount_minor)} — keyingi komissiyalardan avtomatik yopiladi.</div>}
      </section>

      <section className="card wal-pay" id="yechish">
        <h2>Pul yechish</h2>
        {msg && <div className={`notice ${msg.ok ? 'ok' : ''}`} role="status">{msg.text}</div>}
        <div className="wal-card">
          <span>💳 {dest ? <b>{dest.masked}</b> : <span className="muted">Karta kiritilmagan</span>}</span>
          {dest && (dest.verified ? <span className="pill b-delivered">✓ tasdiqlangan</span> : <span className="pill b-shipping">tasdiq kutilmoqda</span>)}
          <button className="link-btn small" onClick={() => setCardEdit(!cardEdit)}>{dest ? 'O‘zgartirish' : 'Karta qo‘shish'}</button>
        </div>
        {(cardEdit || !dest) && (
          <div className="wal-cardform">
            <div className="addr-grid">
              <div><label htmlFor="dh">Karta egasi</label><input id="dh" value={card.holder} onChange={(e) => setCard({ ...card, holder: e.target.value })} placeholder="ISM FAMILIYA" /></div>
              <div><label htmlFor="dnum">Karta raqami</label><input id="dnum" inputMode="numeric" value={card.number} onChange={(e) => setCard({ ...card, number: e.target.value.replace(/\D/g, '').slice(0, 19) })} placeholder="8600 …" /></div>
            </div>
            <button className="btn secondary" disabled={card.holder.trim().length < 3 || card.number.length < 12} onClick={() => act(() => api('/partner/payout-destination', { method: 'PUT', body: { type: 'card', holder: card.holder.trim(), number: card.number } }), 'Karta saqlandi — tasdiqlangach pul yechish mumkin').then(() => setCardEdit(false))}>Kartani saqlash</button>
            <p className="muted small">Yangi karta xavfsizlik uchun do‘kon tomonidan tasdiqlanadi.</p>
          </div>
        )}
        <div className="wal-amt">
          <label htmlFor="am">Qancha yechmoqchisiz? (so‘m)</label>
          <div className="row" style={{ gap: 8 }}>
            <input id="am" inputMode="numeric" value={amt} onChange={(e) => setAmt(e.target.value.replace(/\D/g, ''))} placeholder="Summa" style={{ flex: 1 }} />
            <button type="button" className="btn secondary sm" onClick={() => setAmt(String(BigInt(b.available_minor) / 100n))}>Hammasi</button>
          </div>
          <button className="btn big full mt8" disabled={!amt || amt === '0' || !canWithdraw} onClick={() => act(() => api('/partner/payouts', { method: 'POST', idem: crypto.randomUUID(), body: { amount_minor: String(BigInt(amt) * 100n) } }), 'So‘rov yuborildi. Pul tasdiqlangach kartangizga o‘tkaziladi.').then(() => setAmt(''))}>So‘rov yuborish</button>
          {!canWithdraw && <p className="muted small">{!dest ? 'Avval karta qo‘shing.' : !dest.verified ? 'Karta tasdiqlanishini kuting.' : 'Hozircha yechish mumkin bo‘lgan pul yo‘q.'}</p>}
        </div>
        {payouts.length > 0 && (
          <div className="wal-payouts">
            <h3>So‘rovlarim</h3>
            {payouts.slice(0, 5).map((p) => <div key={p.id} className="wal-row"><span>{new Date(p.created_at).toLocaleDateString('uz-UZ')}</span><b>{som(p.amount_minor)}</b><span className={`wal-st ${p.status === 'paid' ? 'st-ok' : p.status === 'rejected' ? 'st-off' : 'st-wait'}`}>{PAYOUT[p.status] ?? p.status}</span></div>)}
          </div>
        )}
      </section>

      <section className="card" id="lines">
        <h2>Komissiyalarim</h2>
        <div className="wal-filter" role="group" aria-label="Holat bo‘yicha">
          <button type="button" className={`schip ${filter === 'all' ? 'on' : ''}`} aria-pressed={filter === 'all'} onClick={() => { setFilter('all'); setShown(8); }}>Hammasi</button>
          {groups.map((g) => (
            <button key={g.reason} type="button" className={`schip ${filter === g.reason ? 'on' : ''}`} aria-pressed={filter === g.reason} onClick={() => { setFilter(g.reason); setShown(8); }}>
              {STATUS[g.reason]?.label ?? g.label} · {g.count}
            </button>
          ))}
        </div>
        {filter !== 'all' && STATUS[filter] && <p className="muted small">{STATUS[filter]!.help}. Jami: <b>{som(groups.find((g) => g.reason === filter)?.amount_minor ?? '0')}</b></p>}
        {lines.length === 0 && <div className="empty">Bu holatda komissiya yo‘q. <Link href="/partner/new">Buyurtma kiriting</Link></div>}
        <div className="wal-list">
          {lines.slice(0, shown).map((l: any) => (
            <Link key={l.id} href={`/partner/orders/${l.order_id}`} className="wal-line">
              <div className="wl-main"><span className="wl-name">{pick(l.product, lang)}{l.qty > 1 ? ` × ${l.qty}` : ''}</span><span className="muted small">{l.masked_number}{l.reason === 'hold' && l.available_after ? ` · ${new Date(l.available_after).toLocaleDateString('uz-UZ')} da ochiladi` : ''}{l.reversed_reason ? ' · bekor qilindi' : ''}</span></div>
              <div className="wl-side"><b className={l.reason === 'reversed' ? 'no-t' : ''}>{som(l.target_minor)}</b><span className={`wal-st ${STATUS[l.reason]?.cls ?? ''}`}>{STATUS[l.reason]?.label ?? l.reason_label}</span></div>
            </Link>
          ))}
        </div>
        {lines.length > shown && <button className="btn secondary full mt8" onClick={() => setShown(shown + 20)}>Yana ko‘rsatish ({lines.length - shown})</button>}
      </section>

      <details className="card wal-hist">
        <summary><b>Pul harakatlari tarixi</b> <span className="muted small">({ledger.length})</span></summary>
        <div className="wal-list">
          {ledger.slice(0, histShown).map((e) => {
            const st = story(e);
            return (
              <div key={e.id} className="wal-row hist">
                <span className="muted small">{new Date(e.created_at).toLocaleDateString('uz-UZ')}</span>
                <span className="wh-text">{st.text}</span>
                <b className={st.sign === '+' ? 'ok-t' : st.sign === '−' ? 'no-t' : ''}>{st.sign}{som(e.amount_minor)}</b>
              </div>
            );
          })}
        </div>
        {ledger.length > histShown && <button className="btn secondary full mt8" onClick={() => setHistShown(histShown + 30)}>Yana ko‘rsatish</button>}
      </details>

      <details className="card wal-help" id="murojaat">
        <summary><b>Hisob noto‘g‘rimi? Murojaat yozing</b></summary>
        <label htmlFor="dord">Qaysi buyurtma?</label>
        <select id="dord" value={disp.order_id} onChange={(e) => setDisp({ ...disp, order_id: e.target.value })}>
          <option value="">Umumiy savol</option>
          {[...new Map((w.lines ?? []).map((l: any) => [l.order_id, `${l.masked_number} · ${pick(l.product, lang)}`])).entries()].map(([id, n]) => <option key={id as string} value={id as string}>{n as string}</option>)}
        </select>
        <label htmlFor="dsub">Mavzu</label><input id="dsub" value={disp.subject} onChange={(e) => setDisp({ ...disp, subject: e.target.value })} placeholder="Masalan: komissiya kam hisoblangan" />
        <label htmlFor="dbody">Xabar</label><textarea id="dbody" rows={3} value={disp.body} onChange={(e) => setDisp({ ...disp, body: e.target.value })} />
        <button className="btn secondary mt8" disabled={disp.subject.trim().length < 3 || disp.body.trim().length < 3} onClick={() => act(() => api('/partner/disputes', { method: 'POST', body: { ...(disp.order_id ? { order_id: disp.order_id } : {}), subject: disp.subject.trim(), body: disp.body.trim() } }), 'Murojaat yuborildi. Javob shu yerda va Telegram’da keladi.').then(() => setDisp({ order_id: '', subject: '', body: '' }))}>Yuborish</button>
      </details>
    </div>
  );
}
