'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errText } from '@/lib/errors';
import { pick, useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';

const REASONS: [string, string][] = [['spam', 'Spam'], ['personal_data', 'Shaxsiy ma’lumot'], ['offensive', 'Haqoratli'], ['not_about_product', 'Mahsulot haqida emas']];

/** Moderation: publish or reject with a limited reason. A low rating alone is never a reason. */
export function ReviewsAdmin() {
  const { lang } = useI18n();
  const [items, setItems] = useState<any[]>([]);
  const load = useCallback(() => { api('/admin/reviews?status=pending').then((r) => setItems(r.items)).catch(() => {}); }, []);
  useEffect(load, [load]);
  const mod = async (id: string, decision: string, reason?: string) => { try { await api(`/admin/reviews/${id}/moderate`, { method: 'POST', body: { decision, ...(reason ? { reason } : {}) } }); toast('✓'); load(); } catch (e: any) { toast(errText(e), 'err'); } };
  return (
    <section className="card dec">
      <h2>Sharhlarni tekshirish ({items.length})</h2>
      <p className="muted small">Past baho — rad etish sababi emas. Faqat spam, shaxsiy ma’lumot, haqorat yoki mahsulotga aloqasizlik.</p>
      {items.length === 0 && <p className="muted small">Tekshiriladigan sharh yo‘q ✓</p>}
      {items.map((r) => (
        <div key={r.id} className="rv-item">
          <div className="spread small"><b>{pick(r.product, lang)}</b><span className="rv-st">{'★'.repeat(r.rating)}</span></div>
          {r.body && <p>{r.body}</p>}
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <button className="btn sm" onClick={() => mod(r.id, 'published')}>Chop etish</button>
            {REASONS.map(([k, l]) => <button key={k} className="btn secondary sm" onClick={() => mod(r.id, 'rejected', k)}>Rad: {l}</button>)}
          </div>
        </div>
      ))}
    </section>
  );
}
