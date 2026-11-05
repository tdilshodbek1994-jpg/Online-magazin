'use client';
import { useEffect, useState } from 'react';

/** Shows toast() messages on top of everything (also above bottom sheets), so a tap always gets a visible answer. */
export function Toaster() {
  const [t, setT] = useState<{ text: string; kind: string; id: number } | null>(null);
  useEffect(() => {
    let timer: any;
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail; clearTimeout(timer);
      setT({ ...d, id: Date.now() });
      timer = setTimeout(() => setT(null), d.kind === 'err' ? 6000 : 3000);
    };
    window.addEventListener('om-toast', on);
    return () => { window.removeEventListener('om-toast', on); clearTimeout(timer); };
  }, []);
  if (!t) return null;
  return <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'err' ? 'alert' : 'status'} onClick={() => setT(null)}>{t.text}</div>;
}
