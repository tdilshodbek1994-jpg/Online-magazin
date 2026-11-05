'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, som } from '@/lib/api';
import { errText } from '@/lib/errors';
import { toast } from '@/lib/toast';

const SEV: Record<number, [string, string]> = { 1: ['Pul / xavfsizlik', 'sev1'], 2: ['Sotuvni to‘sadi', 'sev2'], 3: ['Kechikish', 'sev3'], 4: ['Tavsiya', 'sev4'] };
const ago = (s: string | null) => { if (!s) return ''; const h = Math.floor((Date.now() - new Date(s).getTime()) / 3600e3); return h < 1 ? 'hozirgina' : h < 48 ? `${h} soatdan beri` : `${Math.floor(h / 24)} kundan beri`; };

/** Owner «Qarorlar va muammolar»: derived from live records — a problem disappears only when the record is fixed. */
export function Decisions({ go }: { go: (tab: string) => void }) {
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const yesterday = new Date(Date.now() + 5 * 3600e3 - 86400e3).toISOString().slice(0, 10);
  const [day, setDay] = useState(yesterday);
  const [fin, setFin] = useState<any>(null);
  const load = useCallback(() => { api('/admin/decisions').then(setD).catch(setErr); }, []);
  const loadDay = useCallback(() => { api(`/admin/finance/day?day=${day}`).then(setFin).catch(() => setFin(null)); }, [day]);
  useEffect(load, [load]);
  useEffect(loadDay, [loadDay]);
  const open = (href: string) => { const m = /[?&]tab=([a-z]+)/.exec(href); if (m) go(m[1]!); else location.href = href; };
  const close = async () => {
    const note = fin?.closes?.length ? window.prompt('Bu kun allaqachon yopilgan. Tuzatish sababini yozing:') : undefined;
    if (fin?.closes?.length && !note) return;
    try { const r = await api('/admin/finance/day/close', { method: 'POST', body: { day, ...(note ? { note } : {}) } }); toast(`✓ ${day} yopildi (versiya ${r.version})`); loadDay(); }
    catch (e: any) { toast(e.code === 'STEP_UP_REQUIRED' ? 'Avval qayta tasdiqlang (MFA).' : errText(e), 'err'); }
  };
  if (err) return <div className="notice" role="alert">{errText(err)}</div>;
  if (!d) return <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>;
  const F: [string, string][] = [['delivered_amount', 'Yetkazilgan buyurtmalar summasi (hali pul emas)'], ['cod_collected', 'Kuryer yig‘gan naqd'], ['cod_remitted', 'Kassaga topshirilgan naqd'], ['online_captured', 'Online to‘lov'], ['refunds_succeeded', 'Mijozga qaytarilgan'], ['payouts_paid', 'Hamkorlarga to‘langan'], ['cod_outstanding_now', 'Kuryerlarda turgan naqd (hozir)']];
  return (
    <div className="dec">
      <div className="dec-head"><h2>Qarorlar va muammolar</h2><button className="btn secondary sm" onClick={load}>Yangilash</button></div>
      {d.items.length === 0 && <div className="empty">Hozir hal qilinishi kerak bo‘lgan muammo yo‘q ✓</div>}
      <div className="dec-list">
        {d.items.map((p: any) => (
          <button key={p.kind} className={`dec-item ${SEV[p.severity]![1]}`} onClick={() => open(p.href)}>
            <span className="dec-sev">{SEV[p.severity]![0]}</span>
            <b className="dec-title">{p.title} <span className="dec-n">{p.count}</span></b>
            <span className="dec-meta">{p.amount_minor ? `${som(p.amount_minor)} · ` : ''}{p.owner_role}{p.since ? ` · ${ago(p.since)}` : ''}</span>
            <span className="dec-hint">{p.hint}</span>
          </button>
        ))}
      </div>
      <section className="card dec-day">
        <div className="dec-head"><h2>Kunni yopish</h2><input type="date" value={day} max={yesterday} onChange={(e) => setDay(e.target.value)} aria-label="Kun" /></div>
        {fin && <dl className="dec-fig">{F.map(([k, l]) => <div key={k}><dt>{l}</dt><dd>{som(String(fin.figures[k] ?? 0))}</dd></div>)}</dl>}
        {fin?.mismatches?.length > 0 && <div className="notice">⚠️ {fin.mismatches.length} ta topshiruvda summa kutilganidan farq qiladi — avval sababini hujjatlang.</div>}
        {fin && <p className="muted small">{fin.note}</p>}
        {fin?.closes?.length > 0 && <p className="small">Yopilgan: v{fin.closes[0].version} · {fin.closes[0].closed_by} · {new Date(fin.closes[0].closed_at).toLocaleString('uz-UZ')}{fin.closes[0].note ? ` · ${fin.closes[0].note}` : ''}</p>}
        <button className="btn" onClick={close}>{fin?.closes?.length ? 'Tuzatish bilan qayta yopish' : 'Kunni yopish'}</button>
      </section>
    </div>
  );
}
