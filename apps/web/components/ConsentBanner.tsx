'use client';
import { useEffect, useState } from 'react';
import { setConsent, trackingConfig } from '@/lib/tracking';

/** Shown only when the shop's ad-measurement dataset is connected and this visitor has not decided yet. */
export function ConsentBanner() {
  const [show, setShow] = useState(false);
  useEffect(() => { trackingConfig().then((c) => setShow(!!c?.consent_required && c.consent === null)); }, []);
  if (!show) return null;
  const decide = async (s: 'granted' | 'denied') => { setShow(false); await setConsent(s); };
  return (
    <div className="consent-bar" role="dialog" aria-label="Reklama o‘lchovi roziligi">
      <p className="small">Reklamamiz samaradorligini o‘lchash uchun (Meta Pixel) ruxsat berasizmi? Rad etsangiz ham buyurtma bemalol ishlaydi. <a href="/legal/privacy">Batafsil</a></p>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn sm" onClick={() => decide('granted')}>Roziman</button>
        <button className="btn secondary sm" onClick={() => decide('denied')}>Rad etaman</button>
      </div>
    </div>
  );
}
