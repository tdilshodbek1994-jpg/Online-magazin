'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errText } from '@/lib/errors';
import { toast } from '@/lib/toast';

/**
 * Saved replies management (supervisor). Editing creates a new version and retires the old one — history stays.
 * Allowed placeholders come only from verified order data; anything else must be filled by the operator.
 */
const VARS = ['{name}', '{number}', '{items}', '{total}'];
const VAR_HELP: [string, string, string][] = [['{name}', 'mijoz ismi', 'Javohir'], ['{number}', 'buyurtma raqami', 'OM-100044'], ['{items}', 'nima buyurtma qilgani', 'Elektr choynak × 1'], ['{total}', 'jami summa', '184 000 so‘m']];
const fill = (t: string) => VAR_HELP.reduce((a, [k, , ex]) => a.split(k).join(ex), t);

export default function ReplyTemplates() {
  const [items, setItems] = useState<any[] | null>(null);
  const [err, setErr] = useState<any>(null);
  const [f, setF] = useState({ code: '', title: '', audience: 'customer', body_latn: '', body_cyrl: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const say = (m: string) => { setMsg(m); toast(m, m.startsWith('✓') ? 'ok' : 'err'); };
  const load = useCallback(() => { api('/admin/reply-templates').then((r) => { setItems(r.items); setErr(null); }).catch(setErr); }, []);
  useEffect(load, [load]);
  if (err) return <div className="notice" role="alert">{err.status === 403 ? 'Bu bo‘lim faqat rahbar uchun.' : errText(err)}</div>;
  const active = (items ?? []).filter((t) => t.status === 'active');
  const upd = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value });
  const unknown = (f.body_latn + ' ' + f.body_cyrl).match(/\{[a-z_]+\}/g)?.filter((v) => !VARS.includes(v)) ?? [];
  return (
    <div className="board">
      <div className="spread"><h1>Tayyor javoblar (SMS shablonlar)</h1><Link href="/ops/board" className="btn secondary sm">← Rahbar paneli</Link></div>
      <section className="card tpl-intro">
        <b>Bu nima?</b>
        <p className="small">Operator mijozga yoki hamkorga SMS/xabar yozganda har safar matnni qaytadan terib o‘tirmasligi uchun <b>oldindan tayyorlangan matnlar</b>. Operator buyurtma oynasidagi «Xabar / izoh yozish» bo‘limida birini tanlaydi — matn o‘zi chiqadi.</p>
        <p className="small">Matn ichidagi qavsli so‘zlar o‘rniga buyurtmadan haqiqiy ma’lumot qo‘yiladi:</p>
        <ul className="small tpl-vars">{VAR_HELP.map(([k, d, ex]) => <li key={k}><code>{k}</code> → {d} <span className="muted">(masalan: {ex})</span></li>)}</ul>
        <p className="muted small">Boshqa {'{…}'} yozsangiz, operator yuborishdan oldin uni qo‘lda to‘ldirishi shart — tizim o‘zidan taxmin qilmaydi.</p>
        {!formOpen && <button className="btn mt8" onClick={() => { setF({ code: '', title: '', audience: 'customer', body_latn: '', body_cyrl: '' }); setFormOpen(true); }}>＋ Yangi javob qo‘shish</button>}
      </section>
      {formOpen && <section className="card tpl-form" id="tpl-form">
        <div className="spread"><h2>{active.some((t) => t.code === f.code) ? 'Javobni o‘zgartirish' : 'Yangi javob'}</h2><button className="link-btn small" onClick={() => setFormOpen(false)}>Yopish</button></div>
        {active.some((t) => t.code === f.code) && <p className="muted small">Saqlasangiz yangi versiya bo‘ladi, eskisi arxivda saqlanib qoladi.</p>}
        <div className="bulk-row">
          <div><label htmlFor="t-code">Ichki nom (faqat lotin harf va _)</label><input id="t-code" value={f.code} onChange={upd('code')} placeholder="masalan: yetkazish_kuni" /></div>
          <div><label htmlFor="t-aud">Kimga</label><select id="t-aud" value={f.audience} onChange={upd('audience')}><option value="customer">👤 Mijozga</option><option value="partner">🤝 Hamkorga</option></select></div>
        </div>
        <label htmlFor="t-title">Qisqa nomi (operator ro‘yxatda shuni ko‘radi)</label><input id="t-title" value={f.title} onChange={upd('title')} />
        <label htmlFor="t-latn">Xabar matni (lotin)</label><textarea id="t-latn" rows={3} value={f.body_latn} onChange={upd('body_latn')} />
        <label htmlFor="t-cyrl">Matn (kirill, ixtiyoriy)</label><textarea id="t-cyrl" rows={3} value={f.body_cyrl} onChange={upd('body_cyrl')} />
        {unknown.length > 0 && <p className="small warn-t">Operator qo‘lda to‘ldiradi: {[...new Set(unknown)].join(', ')}</p>}
        <button className="btn mt8" disabled={!/^[a-z0-9_]{3,40}$/.test(f.code) || f.title.trim().length < 2 || f.body_latn.trim().length < 5} onClick={async () => {
          setMsg(null);
          try { const r = await api('/admin/reply-templates', { method: 'POST', body: { ...f, body_cyrl: f.body_cyrl || undefined } }); say(`✓ Saqlandi (versiya ${r.version})`); setFormOpen(false); setF({ code: '', title: '', audience: 'customer', body_latn: '', body_cyrl: '' }); load(); } catch (e: any) { say(errText(e)); }
        }}>Saqlash</button>
        {f.body_latn.trim() && <div className="tpl-preview"><span className="muted small">Mijoz shunday ko‘radi:</span><div>{fill(f.body_latn)}</div></div>}
        {msg && <div className="small" role="status">{msg}</div>}
      </section>}
      <section className="card">
        <h2>Hozirgi javoblar ({active.length})</h2>
        {active.map((t) => (
          <div key={t.id} className="inc-item">
            <div className="spread"><b>{t.title}</b><span className="pill">{t.audience === 'customer' ? '👤 Mijoz' : '🤝 Hamkor'} · v{t.version}</span></div>
            <div className="small">{fill(t.body_latn)}</div>
            
            <div className="row" style={{ gap: 8 }}>
              <button className="btn secondary sm" onClick={() => { setF({ code: t.code, title: t.title, audience: t.audience, body_latn: t.body_latn, body_cyrl: t.body_cyrl ?? '' }); setFormOpen(true); setTimeout(() => document.getElementById('tpl-form')?.scrollIntoView({ behavior: 'smooth' }), 50); }}>O‘zgartirish</button>
              <button className="link-btn small" onClick={async () => { if (!confirm('Bu javob o‘chirilsinmi? (arxivda saqlanib qoladi)')) return; try { await api(`/admin/reply-templates/${t.id}/retire`, { method: 'POST' }); say('✓ Arxivga o‘tdi'); load(); } catch (e: any) { say(errText(e)); } }}>O‘chirish</button>
            </div>
          </div>
        ))}
        {(items ?? []).some((t) => t.status === 'retired') && <p className="muted small">Arxivda: {(items ?? []).filter((t) => t.status === 'retired').length} ta eski versiya (tarix saqlanadi).</p>}
      </section>
    </div>
  );
}
