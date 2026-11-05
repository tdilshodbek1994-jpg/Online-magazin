'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';

/**
 * Pick check: scan (camera where the browser supports it, or a hardware scanner that types + Enter) or type the SKU.
 * A wrong item is refused on the server and «Qadoqlandi» stays blocked until every unit matches.
 */
export function PickScan({ orderId, onComplete }: { orderId: string; onComplete?: () => void }) {
  const { lang } = useI18n();
  const [d, setD] = useState<any>(null);
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [cam, setCam] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const load = useCallback(() => api(`/ops/orders/${orderId}/pick`).then(setD).catch(() => {}), [orderId]);
  useEffect(() => { void load(); }, [load]);
  const scan = async (value: string) => {
    const v = value.trim(); if (!v) return;
    setCode('');
    try {
      const r = await api(`/ops/orders/${orderId}/pick/scan`, { method: 'POST', body: { code: v } });
      setD(r);
      setMsg(r.ok ? { ok: true, text: `✓ ${v}` } : { ok: false, text: `⛔ ${r.message}` });
      if (r.ok && r.complete) onComplete?.();
      if (!r.ok && navigator.vibrate) navigator.vibrate(300);
    } catch (e: any) { setMsg({ ok: false, text: e.code === 'NOT_PICKING' ? 'Avval «Yig‘ishni boshlash»ni bosing.' : 'Xato, qayta urinib ko‘ring.' }); }
    input.current?.focus();
  };
  // Camera scanning only where the browser has BarcodeDetector (Android Chrome); otherwise typing/scanner works.
  const hasDetector = typeof window !== 'undefined' && 'BarcodeDetector' in window;
  useEffect(() => {
    if (!cam || !hasDetector) return;
    let stream: MediaStream | null = null; let stop = false; let last = '';
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (video.current) { video.current.srcObject = stream; await video.current.play(); }
        const det = new (window as any).BarcodeDetector();
        while (!stop) {
          const found = video.current ? await det.detect(video.current).catch(() => []) : [];
          const raw = found[0]?.rawValue;
          if (raw && raw !== last) { last = raw; await scan(raw); setTimeout(() => { last = ''; }, 1500); }
          await new Promise((r) => setTimeout(r, 350));
        }
      } catch { setCam(false); setMsg({ ok: false, text: 'Kameraga ruxsat berilmadi — kodni yozing.' }); }
    })();
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [cam]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return null;
  return (
    <div className="pk">
      <b>Yig‘ishni tekshirish</b>
      <form className="row" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); void scan(code); }}>
        <input ref={input} aria-label="Shtrix-kod yoki SKU" placeholder="Shtrix-kod yoki SKU" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" />
        <button className="btn sm">OK</button>
        {hasDetector && <button type="button" className="btn secondary sm" onClick={() => setCam(!cam)}>{cam ? '✕' : '📷'}</button>}
      </form>
      {cam && <video ref={video} className="pk-cam" muted playsInline />}
      {msg && <div className={`pk-msg ${msg.ok ? 'ok' : 'bad'}`} role="status">{msg.text}</div>}
      <ul className="pk-lines">{d.lines.map((l: any) => (
        <li key={l.id} className={l.scanned >= l.need ? 'done' : ''}><span>{pick(l.name, lang)} <small className="muted">{l.sku_code}</small></span><b>{l.scanned}/{l.need}</b></li>
      ))}</ul>
      <p className="muted small">{d.complete ? '✓ Hammasi to‘g‘ri — qadoqlash mumkin.' : d.scanned_any ? 'Hamma dona skanerlanmaguncha «Qadoqlandi» bloklanadi.' : 'Skanerlash ixtiyoriy; boshlasangiz, hamma dona tekshiriladi.'}</p>
    </div>
  );
}
