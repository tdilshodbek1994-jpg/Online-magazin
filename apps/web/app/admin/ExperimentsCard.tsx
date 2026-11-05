'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errText } from '@/lib/errors';
import { toast } from '@/lib/toast';

/** A/B sinov: nashrdagi versiya (A) va boshqa versiya (B). Har mijozga bitta variant; g‘olibni faqat egasi tanlaydi. */
export function ExperimentsCard({ id, draftRevision, publishedRevision }: { id: string; draftRevision: number; publishedRevision: number | null }) {
  const [items, setItems] = useState<any[]>([]);
  const [b, setB] = useState(String(draftRevision));
  const load = useCallback(() => { api(`/admin/landings/${id}/experiments`).then((r) => setItems(r.items)).catch(() => {}); }, [id]);
  useEffect(load, [load]);
  const running = items.find((x) => x.status === 'running');
  const run = async (fn: () => Promise<any>, ok: string) => { try { await fn(); toast(ok); load(); } catch (e: any) { toast(e.code === 'OWNER_APPROVAL_REQUIRED' ? 'Faqat egasi.' : e.code === 'SAME_REVISION' ? 'B versiya nashrdagidan farq qilsin.' : errText(e), 'err'); } };
  const pct = (v: number | null) => (v === null ? '—' : `${v.toFixed(1)}%`);
  return (
    <details className="card pp-more" style={{ marginTop: 10 }}>
      <summary>🧪 A/B sinov {running ? '— ishlayapti' : ''}</summary>
      {!running && publishedRevision && <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="small">A = v{publishedRevision} (nashrda), B =</span>
        <select aria-label="B versiya" value={b} onChange={(e) => setB(e.target.value)}>{Array.from({ length: draftRevision }, (_, i) => i + 1).filter((r) => r !== publishedRevision).map((r) => <option key={r} value={r}>v{r}</option>)}</select>
        <button className="btn secondary sm" disabled={draftRevision < 2} onClick={() => run(() => api(`/admin/landings/${id}/experiments`, { method: 'POST', body: { variant_b_revision: Number(b) } }), '✓ Sinov boshlandi')}>Boshlash (egasi)</button>
      </div>}
      {items.map((x) => (
        <div key={x.id} className="small" style={{ marginTop: 8 }}>
          <b>{x.status === 'running' ? 'Ishlayapti' : 'To‘xtatilgan'}</b> · {new Date(x.started_at).toLocaleDateString('uz')}
          <table className="tr-table"><tbody><tr><th>Variant</th><th>Ko‘rgan</th><th>Buyurtma</th><th>Konversiya</th></tr>
            {x.variants.map((v: any) => <tr key={v.variant}><td>{v.variant} (v{v.revision})</td><td>{v.exposures}</td><td>{v.orders}</td><td>{pct(v.rate)}</td></tr>)}
            <tr><td>Jami</td><td>{x.variants.reduce((a: number, v: any) => a + v.exposures, 0)}</td><td>{x.variants.reduce((a: number, v: any) => a + v.orders, 0)}</td><td>{pct(x.pooled_rate)}</td></tr></tbody></table>
          <p className={x.verdict === 'insufficient_data' ? 'notice small' : 'small'}>{x.verdict === 'insufficient_data' ? `Ma’lumot yetarli emas (har variantda kamida ${x.policy.exposures_per_variant} ko‘rish va jami ${x.policy.orders_total} buyurtma kerak). G‘olib avtomatik tanlanmaydi.` : 'Ma’lumot yetarli — qaror egasida (avtomatik nashr yo‘q).'}</p>
          {x.status === 'running' && <button className="btn secondary sm" onClick={() => run(() => api(`/admin/experiments/${x.id}/stop`, { method: 'POST' }), '✓ To‘xtatildi')}>To‘xtatish (egasi)</button>}
        </div>
      ))}
    </details>
  );
}
