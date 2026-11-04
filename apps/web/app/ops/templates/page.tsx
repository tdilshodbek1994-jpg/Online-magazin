'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errText } from '@/lib/errors';

/**
 * Saved replies management (supervisor). Editing creates a new version and retires the old one — history stays.
 * Allowed placeholders come only from verified order data; anything else must be filled by the operator.
 */
const VARS = ['{name}', '{number}', '{items}', '{total}'];

export default function ReplyTemplates() {
  const [items, setItems] = useState<any[] | null>(null);
  const [err, setErr] = useState<any>(null);
  const [f, setF] = useState({ code: '', title: '', audience: 'customer', body_latn: '', body_cyrl: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => { api('/admin/reply-templates').then((r) => { setItems(r.items); setErr(null); }).catch(setErr); }, []);
  useEffect(load, [load]);
  if (err) return <div className="notice" role="alert">{err.status === 403 ? 'Bu bo‘lim faqat rahbar uchun.' : errText(err)}</div>;
  const active = (items ?? []).filter((t) => t.status === 'active');
  const upd = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value });
  const unknown = (f.body_latn + ' ' + f.body_cyrl).match(/\{[a-z_]+\}/g)?.filter((v) => !VARS.includes(v)) ?? [];
  return (
    <div className="board">
      <div className="spread"><h1>Tayyor javoblar</h1><Link href="/ops/board" className="btn secondary sm">← Rahbar paneli</Link></div>
      <p className="muted small">Operator shablonni tanlaganda {VARS.join(', ')} buyurtma ma’lumotidan o‘zi to‘ldiriladi. Boshqa {'{…}'} qoldirsangiz, operator uni yuborishdan oldin qo‘lda yozishi shart — tizim taxmin qilmaydi.</p>
      <section className="card tpl-form">
        <h2>{active.some((t) => t.code === f.code) ? 'Yangi versiya (eskisi arxivga o‘tadi)' : 'Yangi shablon'}</h2>
        <div className="bulk-row">
          <div><label htmlFor="t-code">Kod (lotin, _)</label><input id="t-code" value={f.code} onChange={upd('code')} placeholder="masalan: delivery_day" /></div>
          <div><label htmlFor="t-aud">Kimga</label><select id="t-aud" value={f.audience} onChange={upd('audience')}><option value="customer">👤 Mijozga</option><option value="partner">🤝 Hamkorga</option></select></div>
        </div>
        <label htmlFor="t-title">Sarlavha (operator ko‘radi)</label><input id="t-title" value={f.title} onChange={upd('title')} />
        <label htmlFor="t-latn">Matn (lotin)</label><textarea id="t-latn" rows={3} value={f.body_latn} onChange={upd('body_latn')} />
        <label htmlFor="t-cyrl">Matn (kirill, ixtiyoriy)</label><textarea id="t-cyrl" rows={3} value={f.body_cyrl} onChange={upd('body_cyrl')} />
        {unknown.length > 0 && <p className="small warn-t">Operator qo‘lda to‘ldiradi: {[...new Set(unknown)].join(', ')}</p>}
        <button className="btn mt8" disabled={!/^[a-z0-9_]{3,40}$/.test(f.code) || f.title.trim().length < 2 || f.body_latn.trim().length < 5} onClick={async () => {
          setMsg(null);
          try { const r = await api('/admin/reply-templates', { method: 'POST', body: { ...f, body_cyrl: f.body_cyrl || undefined } }); setMsg(`✓ Saqlandi (versiya ${r.version})`); setF({ code: '', title: '', audience: 'customer', body_latn: '', body_cyrl: '' }); load(); } catch (e: any) { setMsg(errText(e)); }
        }}>Saqlash</button>
        {msg && <div className="small" role="status">{msg}</div>}
      </section>
      <section className="card">
        <h2>Faol shablonlar ({active.length})</h2>
        {active.map((t) => (
          <div key={t.id} className="inc-item">
            <div className="spread"><b>{t.title}</b><span className="pill">{t.audience === 'customer' ? '👤 Mijoz' : '🤝 Hamkor'} · v{t.version}</span></div>
            <div className="small">{t.body_latn}</div>
            {t.body_cyrl && <div className="small muted">{t.body_cyrl}</div>}
            <div className="row" style={{ gap: 8 }}>
              <button className="btn secondary sm" onClick={() => { setF({ code: t.code, title: t.title, audience: t.audience, body_latn: t.body_latn, body_cyrl: t.body_cyrl ?? '' }); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Tahrirlash</button>
              <button className="link-btn small" onClick={async () => { if (!confirm('Shablon arxivga o‘tkazilsinmi?')) return; try { await api(`/admin/reply-templates/${t.id}/retire`, { method: 'POST' }); load(); } catch (e: any) { setMsg(errText(e)); } }}>Arxivlash</button>
            </div>
          </div>
        ))}
        {(items ?? []).some((t) => t.status === 'retired') && <p className="muted small">Arxivda: {(items ?? []).filter((t) => t.status === 'retired').length} ta eski versiya (tarix saqlanadi).</p>}
      </section>
    </div>
  );
}
