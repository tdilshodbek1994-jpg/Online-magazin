'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errText } from '@/lib/errors';
import { pick, useI18n } from '@/lib/i18n';

/** Admin → "Ombor": what is running out, how fast it sells, how many days it lasts. */
const LEVEL: Record<string, [string, string]> = {
  out_selling: ['Tugagan — so‘ralmoqda', 'b-returned'], out: ['Tugagan', 'b-cancelled'], critical: ['7 kundan kam qoldi', 'b-shipping'], low: ['Kam qoldi', 'b-accepted'],
};

export function StockAlerts() {
  const { lang } = useI18n();
  const [days, setDays] = useState(14);
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const [all, setAll] = useState(false);
  const [shown, setShown] = useState(20);
  const load = useCallback(() => { setD(null); api(`/admin/stock/low?days=${days}`).then((r) => { setD(r); setErr(null); }).catch(setErr); }, [days]);
  useEffect(load, [load]);
  if (err) return <div className="notice" role="alert">{errText(err)}</div>;
  return (
    <div className="board">
      <div className="spread">
        <h2>Ombor: tugab qolayotganlar</h2>
        <label className="s-check small">Muddat:
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Necha kunlik zaxira">
            {[7, 14, 30].map((n) => <option key={n} value={n}>{n} kungacha yetadiganlar</option>)}
          </select>
        </label>
      </div>
      {!d ? <p className="muted">Yuklanmoqda…</p> : (
        <>
          <div className="desk-stats">
            {Object.entries(LEVEL).map(([k, [l]]) => d.summary[k] ? <span key={k} className={k === 'out_selling' || k === 'critical' ? 'bad' : ''}><b>{d.summary[k]}</b> {l.toLowerCase()}</span> : null)}
            {d.items.length === 0 && <span>✓ Hammasi yetarli</span>}
          </div>
          <div className="chips" role="group" aria-label="Filtr">
            <button type="button" className={`chip ${!all ? 'on' : ''}`} onClick={() => { setAll(false); setShown(20); }}>Sotilayotganlar ({d.items.filter((r: any) => r.sold_30d > 0).length})</button>
            <button type="button" className={`chip ${all ? 'on' : ''}`} onClick={() => { setAll(true); setShown(20); }}>Barchasi ({d.items.length})</button>
          </div>
          {!all && d.items.filter((r: any) => r.sold_30d > 0).length === 0 && <p className="notice ok">Sotilayotgan mahsulotlarda tanqislik yo‘q ✓</p>}
          <div className="slist">
            {d.items.filter((r: any) => all || r.sold_30d > 0).slice(0, shown).map((r: any) => (
              <article key={r.sku_id} className="scard stock-row">
                {r.image ? <img src={r.image} alt="" width={52} height={52} /> : <span className="ph" aria-hidden />}
                <div className="stock-info">
                  <b>{pick(r.name, lang)}{r.variant && Object.values(r.variant).length ? ` (${Object.values(r.variant).join('/')})` : ''}</b>
                  <span className="small muted">{r.sku_code}</span>
                  <span className="small">Omborda: <b>{r.available}</b> · 30 kunda sotildi: <b>{r.sold_30d}</b></span>
                  <span className="small">{r.days_left === null ? 'Sotuv yo‘q — prognoz qilinmaydi' : r.available === 0 ? 'Tugagan' : `≈ ${r.days_left} kunga yetadi`}</span>
                </div>
                <span className={`pill ${LEVEL[r.level]?.[1] ?? ''}`}>{LEVEL[r.level]?.[0] ?? r.level}</span>
              </article>
            ))}
          </div>
          {d.items.filter((r: any) => all || r.sold_30d > 0).length > shown && <button className="btn secondary full mt8" onClick={() => setShown(shown + 20)}>Yana ko‘rsatish</button>}
          <p className="muted small">{d.note}</p>
        </>
      )}
    </div>
  );
}
