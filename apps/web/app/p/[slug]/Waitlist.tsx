'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';

/**
 * Sold-out product (V2 §09): instead of a dead end, say "Hozir mavjud emas", offer a consented waitlist
 * (one SMS when it is back) and in-stock alternatives from the same category.
 */
export function Waitlist({ productId }: { productId: string }) {
  const { lang } = useI18n();
  const [phone, setPhone] = useState('');
  const [consent, setConsent] = useState(false);
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [alts, setAlts] = useState<any[]>([]);
  useEffect(() => { api(`/products/${productId}/alternatives`).then((r) => setAlts(r.items)).catch(() => {}); }, [productId]);
  return (
    <section className="card waitlist" aria-labelledby="wl-h">
      <h2 id="wl-h">Hozir mavjud emas</h2>
      {state === 'done' ? <p className="notice ok" role="status">Rahmat! Mahsulot qaytib kelganda bir marta SMS yuboramiz.</p> : (
        <form onSubmit={async (e) => {
          e.preventDefault(); setState('busy');
          try { await api('/waitlist', { method: 'POST', body: { product_id: productId, phone, consent: true } }); setState('done'); } catch { setState('error'); }
        }}>
          <p className="muted small">Mahsulot qayta kelganda xabar beramiz — faqat bir marta.</p>
          <label htmlFor="wlp">Telefon raqamingiz</label>
          <input id="wlp" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+998 90 123 45 67" autoComplete="tel" />
          <label className="check-row"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> Shu mahsulot bo‘yicha bitta SMS olishga roziman</label>
          {state === 'error' && <div className="field-error" role="alert">Telefon raqamini tekshiring</div>}
          <button className="btn" disabled={!consent || phone.replace(/\D/g, '').length < 9 || state === 'busy'}>Kelganda xabar bering</button>
        </form>
      )}
      {alts.length > 0 && (
        <>
          <h3>O‘xshash mahsulotlar — hozir bor</h3>
          <div className="alt-row">
            {alts.map((a) => (
              <Link key={a.id} href={`/p/${a.slug}`} className="alt-card">
                {a.image ? <img src={a.image} alt="" loading="lazy" /> : <span className="ph" aria-hidden />}
                <span>{pick(a.name, lang)}</span>
                {a.price_minor && <b>{som(a.price_minor)}</b>}
              </Link>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
