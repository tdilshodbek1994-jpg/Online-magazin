'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';
import { BUCKET_LABEL } from '../shared';
import { errText } from '@/lib/errors';

/**
 * Mijozlar daftari (V2 §14): only contacts from the partner's own drafts/orders. It does not make the customer
 * the partner's property — every new sale follows the current attribution rules.
 */
export default function Contacts() {
  const { lang } = useI18n();
  const [q, setQ] = useState('');
  const [items, setItems] = useState<any[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [shown, setShown] = useState(20);
  const load = (query = q) => api(`/partner/contacts${query ? `?q=${encodeURIComponent(query)}` : ''}`).then((r) => setItems(r.items)).catch(() => setItems([]));
  useEffect(() => { void load(''); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const patch = async (id: string, body: any) => { await api(`/partner/contacts/${id}`, { method: 'PATCH', body }).catch(() => {}); void load(); };
  const reorder = async (c: any) => {
    setMsg(null);
    const reuse = c.last_order_id ? confirm('Mijoz manzili o‘zgarmaganini va uni qayta ishlatishga rozi ekanini tasdiqlaysizmi?\n\nOK — manzil qayta ishlatiladi\nBekor — manzilni yangidan kiritasiz') : false;
    try { const d = await api(`/partner/contacts/${c.id}/reorder`, { method: 'POST', body: { reuse_address: reuse } }); location.href = `/partner/new?draft=${d.id}`; }
    catch (e: any) { setMsg(e.code === 'DO_NOT_CONTACT' ? 'Mijoz bog‘lanmaslikni so‘ragan' : e.code === 'NO_PREVIOUS_ORDER' ? 'Bu mijozda hali buyurtma yo‘q' : errText(e)); }
  };
  return (
    <>
      <h1>Mijozlar daftari</h1>
      <p className="muted small">Bu yerda faqat siz o‘zingiz buyurtma kiritgan yoki havolangiz orqali ma’lumot qoldirgan mijozlar bor. Mijoz o‘zi kiritgan raqam qisman yashiriladi. Daftar mijozni sizga «biriktirib» qo‘ymaydi — har yangi sotuv umumiy qoidaga ko‘ra hisoblanadi.</p>
      <form className="search plain" role="search" onSubmit={(e) => { e.preventDefault(); void load(q.trim()); }}>
        <label htmlFor="cq" className="sr-only">Mijoz qidirish</label>
        <input id="cq" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ism yoki telefon…" />
        <button className="search-btn" aria-label="Izlash">Izlash</button>
      </form>
      {msg && <div className="notice" role="alert">{msg}</div>}
      {items === null && <div className="loading" role="status"><span className="spinner" aria-hidden />Yuklanmoqda…</div>}
      {items?.length === 0 && <div className="empty">Hali mijoz yo‘q. <Link href="/partner/new">Birinchi buyurtmani kiriting</Link> — mijoz shu yerda paydo bo‘ladi.</div>}
      <div className="slist">
        {items?.slice(0, shown).map((c) => (
          <article key={c.id} className={`scard ${c.do_not_contact ? 'muted-card' : ''}`}>
            <div className="spread">
              <b>{c.name || 'Ismsiz'} · {c.entered_by_partner ? <a href={`tel:${c.phone}`}>{c.phone}</a> : c.phone}</b>
              {c.last_bucket && <span className={`pill b-${c.last_bucket}`}>{BUCKET_LABEL[c.last_bucket]}</span>}
            </div>
            {c.interested?.length > 0 && <div className="small">Qiziqqan: {c.interested.map((n: any) => pick(n, lang)).join(', ')}</div>}
            <div className="small muted">{c.contact_time ? `📞 ${c.contact_time} · ` : ''}Oxirgi: {new Date(c.last_activity_at).toLocaleDateString('uz-UZ')}{c.last_order_masked ? ` · ${c.last_order_masked}` : ''}</div>
            {c.do_not_contact && <div className="small no-t">🚫 Mijoz bog‘lanmaslikni so‘ragan</div>}
            {c.note && <div className="small">📝 {c.note}</div>}
            <div className="row" style={{ gap: 8 }}>
              {!c.do_not_contact && c.last_order_id && <button className="btn sm" onClick={() => reorder(c)}>Qayta buyurtma</button>}
              {c.last_order_id && <Link className="btn secondary sm" href={`/partner/orders/${c.last_order_id}`}>Oxirgi buyurtma</Link>}
              <button className="link-btn small" onClick={() => setOpen(open === c.id ? null : c.id)}>{open === c.id ? 'Yopish' : 'Izoh / sozlash'}</button>
            </div>
            {open === c.id && <ContactEdit c={c} onSave={(b) => patch(c.id, b)} />}
          </article>
        ))}
        {items && items.length > shown && <button className="btn secondary full" onClick={() => setShown(shown + 30)}>Yana ko‘rsatish ({items.length - shown} ta qoldi)</button>}
      </div>
    </>
  );
}

function ContactEdit({ c, onSave }: { c: any; onSave: (b: any) => void }) {
  const [note, setNote] = useState(c.note ?? '');
  const [time, setTime] = useState(c.contact_time ?? '');
  return (
    <div className="contact-edit">
      <label htmlFor={`n-${c.id}`}>Izoh (faqat siz ko‘rasiz)</label>
      <input id={`n-${c.id}`} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
      <label htmlFor={`t-${c.id}`}>Qulay aloqa vaqti</label>
      <input id={`t-${c.id}`} maxLength={120} value={time} onChange={(e) => setTime(e.target.value)} />
      <label className="check-row"><input type="checkbox" defaultChecked={c.do_not_contact} onChange={(e) => onSave({ do_not_contact: e.target.checked })} /> Mijoz bog‘lanmaslikni so‘radi</label>
      <button className="btn secondary sm" onClick={() => onSave({ note: note || null, contact_time: time || null })}>Saqlash</button>
    </div>
  );
}
