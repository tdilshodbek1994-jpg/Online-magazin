'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errText } from '@/lib/errors';
import { pick, useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';

const ST: Record<string, string> = { draft: 'Qoralama', approved: 'Tasdiqlandi', ordered: 'Buyurtma berildi', partially_received: 'Qisman keldi', received: 'To‘liq keldi', cancelled: 'Bekor qilindi' };

/** Replenishment: suggestions → purchase draft → owner approval → ordered → receipts (stock grows only on receipt). */
export function Replenishment() {
  const { lang } = useI18n();
  const [sg, setSg] = useState<any>(null);
  const [pos, setPos] = useState<any[]>([]);
  const [pick_, setPick] = useState<Record<string, number>>({});
  const [open, setOpen] = useState<any>(null);
  const [recv, setRecv] = useState<Record<string, number>>({});
  const load = useCallback(() => {
    api('/admin/replenishment/suggestions').then((r) => { setSg(r); setPick(Object.fromEntries(r.items.map((x: any) => [x.sku_id, x.suggest]))); }).catch(() => setSg({ items: [] }));
    api('/admin/purchase-orders').then((r) => setPos(r.items)).catch(() => {});
  }, []);
  useEffect(load, [load]);
  const draft = async () => {
    const lines = Object.entries(pick_).filter(([, q]) => q > 0).map(([sku_id, qty]) => ({ sku_id, qty }));
    if (!lines.length) return;
    try { const r = await api('/admin/purchase-orders', { method: 'POST', body: { lines } }); toast(`✓ ${r.number} qoralama yaratildi`); load(); } catch (e: any) { toast(errText(e), 'err'); }
  };
  const show = async (id: string) => { try { setOpen(await api(`/admin/purchase-orders/${id}`)); setRecv({}); } catch (e: any) { toast(errText(e), 'err'); } };
  const act = async (path: string, ok: string, body?: any) => {
    try { const r = await api(`/admin/purchase-orders/${open.id}/${path}`, { method: 'POST', ...(body ? { body } : {}) }); setOpen(r); toast(ok); load(); }
    catch (e: any) { toast(e.code === 'STEP_UP_REQUIRED' ? 'Avval qayta tasdiqlang (MFA).' : e.code === 'RECEIVE_EXCEEDS_ORDERED' ? 'Buyurtma qilinganidan ko‘p kiritdingiz.' : errText(e), 'err'); }
  };
  return (
    <div className="dec">
      <section className="card">
        <div className="dec-head"><h2>To‘ldirish kerak</h2><span className="muted small">{sg?.target_days ?? 30} kunlik zaxira</span></div>
        {sg?.items.length === 0 && <p className="muted small">Hozir to‘ldirish kerak bo‘lgan tovar yo‘q ✓</p>}
        {sg?.items.map((x: any) => (
          <div key={x.sku_id} className="rp-row">
            <span className="rp-name">{pick(x.name, lang)} <small className="muted">{x.sku_code}</small><small className="muted"> · bor {x.available} · 30 kunda {x.sold_30d} sotildi{x.incoming ? ` · yo‘lda ${x.incoming}` : ''}</small></span>
            <input type="number" min={0} className="rp-qty" aria-label="Soni" value={pick_[x.sku_id] ?? 0} onChange={(e) => setPick({ ...pick_, [x.sku_id]: Math.max(0, Number(e.target.value)) })} />
          </div>
        ))}
        {sg?.items.length > 0 && <button className="btn" onClick={draft}>Xarid qoralamasini yaratish</button>}
        {sg && <p className="muted small">{sg.method}</p>}
      </section>
      <section className="card">
        <h2>Xarid buyurtmalari</h2>
        {pos.length === 0 && <p className="muted small">Hali yo‘q.</p>}
        {pos.map((p) => (
          <button key={p.id} className="dec-item sev4" onClick={() => show(p.id)}>
            <b className="dec-title">{p.number} · {ST[p.status]}</b>
            <span className="dec-meta">{p.supplier ?? 'ta’minotchi ko‘rsatilmagan'} · {p.units} dona · keldi {p.received}</span>
          </button>
        ))}
      </section>
      {open && (
        <section className="card">
          <div className="dec-head"><h2>{open.number} — {ST[open.status]}</h2><button className="link-btn" onClick={() => setOpen(null)}>✕</button></div>
          {open.lines.map((l: any) => (
            <div key={l.id} className="rp-row">
              <span className="rp-name">{pick(l.name, lang)} <small className="muted">{l.sku_code} · {l.qty_received}/{l.qty_ordered}</small></span>
              {['ordered', 'partially_received'].includes(open.status) && l.qty_received < l.qty_ordered && <input type="number" min={0} max={l.qty_ordered - l.qty_received} className="rp-qty" aria-label="Kelgan soni" value={recv[l.id] ?? 0} onChange={(e) => setRecv({ ...recv, [l.id]: Math.max(0, Number(e.target.value)) })} />}
            </div>
          ))}
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {open.status === 'draft' && <button className="btn" onClick={() => act('approve', '✓ Tasdiqlandi')}>Tasdiqlash (egasi)</button>}
            {open.status === 'approved' && <button className="btn" onClick={() => act('ordered', '✓ Ta’minotchiga yuborildi deb belgilandi')}>Ta’minotchiga yuborildi</button>}
            {['ordered', 'partially_received'].includes(open.status) && <button className="btn" onClick={() => { const ref = prompt('Nakladnoy raqami:'); if (!ref) return; const lines = Object.entries(recv).filter(([, q]) => q > 0).map(([line_id, qty]) => ({ line_id, qty })); if (lines.length) act('receive', '✓ Qabul qilindi — qoldiqqa qo‘shildi', { ref, lines }); }}>Kelgan tovarni qabul qilish</button>}
            {['draft', 'approved', 'ordered'].includes(open.status) && <button className="btn secondary danger-t" onClick={() => act('cancel', 'Bekor qilindi')}>Bekor qilish</button>}
          </div>
          <p className="muted small">Kutilayotgan tovar qoldiqqa qo‘shilmaydi — faqat haqiqatan qabul qilinganda qo‘shiladi.</p>
        </section>
      )}
    </div>
  );
}
