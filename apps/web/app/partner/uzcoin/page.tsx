'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, som } from '@/lib/api';
import { errText } from '@/lib/errors';
import { toast } from '@/lib/toast';

const KIND_UZ: Record<string, string> = { earned_sale: 'Sotuv', return_adjustment: 'Qaytarish tuzatishi', contest_prize: 'Konkurs sovrini', exchange_reserve: 'Almashtirishga band', exchange_release: 'Band bekor qilindi', exchange_paid: 'Pulga almashtirildi', gift_reserve: 'Sovg‘aga band', gift_release: 'Sovg‘a bekor', gift_spent: 'Sovg‘aga sarflandi', correction: 'Tuzatish' };
const GO_UZ: Record<string, string> = { created: 'Yaratildi', confirmed: 'Tasdiqlandi', preparing: 'Tayyorlanmoqda', shipped: 'Jo‘natildi', delivered: 'Topshirildi', canceled: 'Bekor qilindi' };
const EX_UZ: Record<string, string> = { requested: 'So‘rov yuborildi', approved: 'Hamyoningizga o‘tkazildi', rejected: 'Rad etildi (coin qaytdi)', canceled: 'Bekor' };
const n = (v: string | number) => Number(v).toLocaleString('ru-RU');

/** Partner «🪙 UzCoin»: wallet → gifts → exchange → history. All numbers come from the backend ledger. */
export default function UzCoin() {
  const [d, setD] = useState<any>(null);
  const [gifts, setGifts] = useState<any[]>([]);
  const [lvl, setLvl] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const [tab, setTab] = useState<'wallet' | 'gifts' | 'exchange' | 'history'>('wallet');
  const [coins, setCoins] = useState('');
  const [pv, setPv] = useState<any>(null);
  const load = useCallback(() => { api('/partner/uzcoin').then(setD).catch(setErr); api('/partner/uzcoin/gifts').then((r) => { setGifts(r.items); setLvl(r.level); }).catch(() => {}); }, []);
  useEffect(load, [load]);
  useEffect(() => { if (!coins || coins === '0') { setPv(null); return; } const id = setTimeout(() => api(`/partner/uzcoin/preview?coins=${coins}`).then(setPv).catch(() => setPv(null)), 250); return () => clearTimeout(id); }, [coins]);
  if (err) return <div className="notice" role="alert">{errText(err)}</div>;
  if (!d) return <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>;
  const b = d.balance;
  return (
    <div className="cc">
      <div className="uzc-hero">
        <span>🪙 Mavjud UzCoin</span>
        <b>{n(b.available)}</b>
        <small>1 UzCoin = {som(d.rate.som_per_coin_minor)} · {n(b.available)} × {som(d.rate.som_per_coin_minor)} = {som(String(BigInt(b.available) * BigInt(d.rate.som_per_coin_minor)))}</small>
      </div>
      <div className="chips" role="tablist">{([['wallet', 'Hamyon'], ['gifts', 'Sovg‘alar'], ['exchange', 'Pulga almashtirish'], ['history', 'Tarix']] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`chip ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{l}</button>)}</div>

      {tab === 'wallet' && (
        <div className="uzc-grid">
          {[['Jami ishlab topilgan', b.earned_total], ['Konkurslardan', b.contest_total], ['Tasdiqlanishi kutilmoqda', b.pending_projection], ['Almashtirishga band', b.reserved], ['Pulga almashtirilgan', b.exchanged_total], ['Sovg‘alarga sarflangan', b.spent_total], ['Qaytarish sabab tuzatilgan', b.adjusted_total], ...(b.debt !== '0' ? [['Keyingi coinlardan qoplanadi', b.debt]] : [])].map(([l, v]) => <div key={l as string}><span>{l}</span><b>{n(v as string)}</b></div>)}
          <p className="small muted" style={{ gridColumn: '1 / -1' }}>1 ta yetkazilgan, to‘lovi tasdiqlangan va qaytarish muddati o‘tgan dona = 1 UzCoin. Komissiya miqdori coin soniga ta’sir qilmaydi. UzCoin — mukofot birligi, kriptovalyuta emas.</p>
        </div>
      )}

      {tab === 'gifts' && (
        <div className="slist">
          {lvl && <div className="notice small">{lvl.badge} Darajangiz: <b>{lvl.name}</b> · sovg‘alarga chegirma <b>{lvl.discount_bps / 100}%</b> <Link href="/partner/level">Darajam ›</Link></div>}
          {gifts.length === 0 && <div className="empty">Hozircha sovg‘a yo‘q.</div>}
          {gifts.map((g) => (
            <div key={g.id} className="scard uzc-gift">
              {g.images?.[0] && <img src={g.images[0]} alt="" loading="lazy" />}
              <div className="spread"><b>{g.title}</b><b className="uzc-price">🪙 {n(g.final_price_coins ?? g.price_coins)}</b></div>
              {g.discount_bps > 0 && <div className="small">Asl narx: <s>🪙 {n(g.base_price_coins)}</s> · {lvl?.name} chegirmasi {g.discount_bps / 100}% · <b>Tejaysiz: 🪙 {n(g.saved_coins)}</b></div>}
              {g.description && <p className="small muted">{g.description}</p>}
              <div className="small muted">{g.stock > 0 ? `${g.stock} ta qoldi` : 'Tugagan'}{g.delivery_terms ? ` · ${g.delivery_terms}` : ''}{g.per_partner_limit ? ` · bir kishiga ${g.per_partner_limit} ta` : ''}</div>
              <button className="btn sm" disabled={g.stock < 1 || BigInt(b.available) < BigInt(g.final_price_coins ?? g.price_coins)} onClick={async () => {
                const address = prompt('Yetkazish manzili (shahar, tuman, ko‘cha, uy)'); if (!address) return;
                if (!confirm(`${g.title} uchun ${n(g.final_price_coins ?? g.price_coins)} UzCoin band qilinadi. Tasdiqlaysizmi?`)) return;
                try { await api(`/partner/uzcoin/gifts/${g.id}/order`, { method: 'POST', idem: crypto.randomUUID(), body: { address } }); toast('✓ Sovg‘a buyurtmasi yaratildi'); load(); }
                catch (e: any) { toast(e.code === 'GIFT_OUT_OF_STOCK' ? 'Sovg‘a tugab qoldi.' : e.code === 'UZCOIN_INSUFFICIENT' ? 'UzCoin yetarli emas.' : e.code === 'GIFT_LIMIT_REACHED' ? 'Bu sovg‘a uchun limitingiz tugagan.' : errText(e), 'err'); }
              }}>{BigInt(b.available) < BigInt(g.final_price_coins ?? g.price_coins) ? `Yana ${n(String(BigInt(g.final_price_coins ?? g.price_coins) - BigInt(b.available)))} coin kerak` : 'Sovg‘ani olish'}</button>
            </div>
          ))}
          {d.gift_orders.length > 0 && <section className="card"><b>Mening sovg‘alarim</b>{d.gift_orders.map((o: any) => <div key={o.id} className="spread small w-prod"><span>{o.gift_title} · 🪙 {n(o.price_coins)}</span><span>{GO_UZ[o.status]}{o.status === 'created' && <button className="link-btn small" onClick={async () => { if (!confirm('Bekor qilinsinmi? Coin qaytadi.')) return; await api(`/partner/uzcoin/gift-orders/${o.id}/cancel`, { method: 'POST' }).catch(() => {}); load(); }}> · bekor</button>}</span></div>)}</section>}
        </div>
      )}

      {tab === 'exchange' && (
        <section className="card cc-form">
          <label htmlFor="uzc-n">Nechta UzCoin almashtirasiz?</label>
          <div className="row" style={{ gap: 8 }}><input id="uzc-n" inputMode="numeric" value={coins} onChange={(e) => setCoins(e.target.value.replace(/\D/g, '').slice(0, 8))} style={{ flex: 1 }} /><button className="btn secondary" onClick={() => setCoins(b.available)}>Hammasi</button></div>
          {pv && <p className="small">{n(pv.coins)} × {som(pv.som_per_coin_minor)} = <b>{som(pv.amount_minor)}</b> (kurs v{pv.rate_version})</p>}
          <button className="btn" disabled={!coins || coins === '0' || BigInt(coins || '0') > BigInt(b.available)} onClick={async () => {
            if (!confirm(`${n(coins)} UzCoin band qilinadi va ${pv ? som(pv.amount_minor) : ''} uchun so‘rov yaratiladi. Tasdiqlaysizmi?`)) return;
            try { await api('/partner/uzcoin/exchanges', { method: 'POST', idem: crypto.randomUUID(), body: { coins: Number(coins) } }); toast('✓ So‘rov yuborildi — tasdiqlangach pul hamyoningizga tushadi'); setCoins(''); load(); }
            catch (e: any) { toast(e.code === 'UZCOIN_INSUFFICIENT' ? 'UzCoin yetarli emas.' : errText(e), 'err'); }
          }}>Pulga almashtirish</button>
          <p className="small muted">So‘rov — hali pul o‘tkazildi degani emas. Admin tasdiqlagach summa «Yechish mumkin» balansingizga tushadi va odatdagidek kartaga yechasiz. Rad etilsa coinlar qaytadi.</p>
          {d.exchanges.map((e: any) => <div key={e.id} className="spread small w-prod"><span>{n(e.coins)} coin · {som(e.amount_minor)}</span><span>{EX_UZ[e.status]}</span></div>)}
        </section>
      )}

      {tab === 'history' && (
        <section className="card">
          {d.history.length === 0 && <p className="muted small">Hali operatsiya yo‘q.</p>}
          {d.history.map((h: any) => <div key={h.id} className="spread small w-prod"><span>{new Date(h.created_at).toLocaleDateString('uz-UZ')} · {KIND_UZ[h.kind] ?? h.kind}{h.product_name ? ` · ${h.product_name}` : ''}{h.qty ? ` × ${Math.abs(h.qty)}` : ''}{h.order_number ? ` · ${h.order_number}` : ''}</span><b className={Number(h.coins) < 0 ? 'no-t' : 'ok-t'}>{Number(h.coins) > 0 ? '+' : ''}{n(h.coins)}</b></div>)}
        </section>
      )}
    </div>
  );
}
