'use client';
import { useState } from 'react';
import { api, som } from '@/lib/api';
import { errText } from '@/lib/errors';
import { toast } from '@/lib/toast';

/**
 * "Mijoz uchun chegirma": makes a NEW link for the same product where the customer sees price − discount.
 * The old link stays as it is. The discount is paid from the partner's own commission, so it is capped by it.
 */
export function DiscountMaker({ s, onMade }: { s: any; onMade: () => void }) {
  const [open, setOpen] = useState(false);
  const [lim, setLim] = useState<any>(null);
  const [amt, setAmt] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!s.product_id) return null;
  const disc = BigInt(s.customer_discount_minor ?? '0');
  if (disc > 0n) {
    const price = s.price_minor ? BigInt(s.price_minor) : null;
    return <div className="disc-badge">🎁 Chegirmali havola: mijoz <b>{price ? som((price - disc).toString()) : ''}</b> ko‘radi <span className="muted">(−{som(disc.toString())}, sizning bonusingizdan)</span></div>;
  }
  const minor = amt ? BigInt(amt) * 100n : 0n;
  const max = lim ? BigInt(lim.max_discount_minor) : 0n;
  const tooBig = lim && minor > max;
  return (
    <div className="disc-maker">
      {!open ? (
        <button type="button" className="btn secondary sm" onClick={() => { setOpen(true); if (!lim) api(`/partner/streams/discount-limit?product_id=${s.product_id}`).then(setLim).catch((e) => setErr(errText(e))); }}>🎁 Mijoz uchun chegirma</button>
      ) : (
        <div className="disc-form">
          <b>Mijoz uchun chegirmali yangi havola</b>
          <p className="small muted">Eski havola o‘zgarmaydi — xohlasangiz ikkalasidan ham foydalanasiz. Chegirma sizning bonusingizdan ayiriladi.</p>
          {lim && <p className="small">Narx: <b>{som(lim.price_minor)}</b> · bonusingiz: <b>{som(lim.commission_minor)}</b> · eng ko‘pi bilan <b>{som(lim.max_discount_minor)}</b> chegirma bera olasiz.</p>}
          <label htmlFor={`da-${s.id}`}>Chegirma (so‘m)</label>
          <input id={`da-${s.id}`} inputMode="numeric" value={amt} onChange={(e) => setAmt(e.target.value.replace(/\D/g, '').slice(0, 9))} placeholder="Masalan: 10000" />
          {lim && minor > 0n && !tooBig && <p className="small ok-t">Mijoz ko‘radi: <b>{som((BigInt(lim.price_minor) - minor).toString())}</b> · sizga qoladi: <b>{som((BigInt(lim.commission_minor) - minor).toString())}</b> (har dona)</p>}
          {tooBig && <p className="small no-t">Bonusingizdan ko‘p chegirma berib bo‘lmaydi (eng ko‘pi {som(lim.max_discount_minor)}).</p>}
          {err && <p className="small no-t" role="alert">{err}</p>}
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn sm" disabled={busy || !lim || minor <= 0n || !!tooBig} onClick={async () => {
              setBusy(true); setErr(null);
              try {
                await api('/partner/streams', { method: 'POST', body: { product_id: s.product_id, name: `${s.name ?? 'Oqim'} · −${Number(amt).toLocaleString('ru-RU')} so‘m`.slice(0, 80), customer_discount_minor: minor.toString() } });
                toast('✓ Chegirmali havola yaratildi — ro‘yxatning tepasida'); setOpen(false); setAmt(''); onMade();
              } catch (e: any) { setErr(e.code === 'DISCOUNT_TOO_BIG' ? 'Chegirma bonusingizdan katta.' : errText(e)); } finally { setBusy(false); }
            }}>Havola yaratish</button>
            <button type="button" className="link-btn small" onClick={() => setOpen(false)}>Bekor</button>
          </div>
        </div>
      )}
    </div>
  );
}
