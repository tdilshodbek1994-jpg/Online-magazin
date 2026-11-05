'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, getToken } from '@/lib/api';
import { AREA_KEY, type Area, areasFor } from '@/lib/native';

/**
 * App start screen (the Android app opens /app). One app for everyone: a customer lands in the shop, a person with one
 * work role goes straight to it, a person with several roles picks once (remembered; «Bo‘limlar» changes it).
 */
export default function AppHome() {
  const router = useRouter();
  const [areas, setAreas] = useState<Area[] | null>(null);
  const [name, setName] = useState('');

  useEffect(() => {
    const choose = new URLSearchParams(location.search).get('choose') === '1';
    if (!getToken()) { router.replace('/'); return; }
    Promise.all([api('/me'), api('/partner/me').then(() => true).catch(() => false)]).then(([me, isPartner]) => {
      const list = areasFor(me, isPartner);
      const work = list.filter((a) => a.key !== 'shop');
      let saved: string | null = null;
      try { saved = localStorage.getItem(AREA_KEY); } catch {}
      const remembered = list.find((a) => a.key === saved);
      if (!choose && remembered) { router.replace(remembered.href); return; }
      if (!choose && work.length === 0) { router.replace('/'); return; }
      if (!choose && work.length === 1) { router.replace(work[0]!.href); return; }
      setName(me.display_name ?? '');
      setAreas(list);
    }).catch(() => router.replace('/'));
  }, [router]);

  if (!areas) return <div className="tg-entry"><div className="tg-spin" aria-label="Yuklanmoqda" /></div>;
  return (
    <div className="app-areas">
      <h1>{name ? `Assalomu alaykum, ${name}!` : 'Assalomu alaykum!'}</h1>
      <p className="muted">Qaysi bo‘limni ochamiz? Tanlovingiz eslab qolinadi.</p>
      <div className="aa-list">
        {areas.map((a) => (
          <button key={a.key} type="button" className={`aa-card aa-${a.key}`} onClick={() => { try { localStorage.setItem(AREA_KEY, a.key); } catch {} router.replace(a.href); }}>
            <span className="aa-icon" aria-hidden>{a.icon}</span>
            <span className="aa-text"><b>{a.title}</b><small>{a.text}</small></span>
            <span aria-hidden>›</span>
          </button>
        ))}
      </div>
    </div>
  );
}
