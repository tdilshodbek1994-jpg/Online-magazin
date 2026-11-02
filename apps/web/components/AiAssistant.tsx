'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';

const MSG: Record<string, Record<string, string>> = {
  'uz-Latn': { title: 'AI yordamchi', ph: 'Masalan: 200 mingdan arzon quloqchin kerak', ask: 'So‘rash', found: 'Mos mahsulotlar:', none: 'Mos mahsulot topilmadi. Qidiruv yoki operatorga murojaat qiling.', budget: 'Bu byudjetda mos mahsulot topilmadi.', detail: 'Iltimos, nima kerakligini batafsilroq yozing.', note: 'AI javobi. Narx va mavjudlik buyurtma vaqtida qayta tekshiriladi.', off: 'AI vaqtincha ishlamayapti — oddiy qidiruvdan foydalaning.' },
  'uz-Cyrl': { title: 'AI ёрдамчи', ph: 'Масалан: 200 мингдан арзон қулоқчин керак', ask: 'Сўраш', found: 'Мос маҳсулотлар:', none: 'Мос маҳсулот топилмади. Қидирув ёки операторга мурожаат қилинг.', budget: 'Бу бюджетда мос маҳсулот топилмади.', detail: 'Илтимос, нима кераклигини батафсилроқ ёзинг.', note: 'AI жавоби. Нарх ва мавжудлик буюртма вақтида қайта текширилади.', off: 'AI вақтинча ишламаяпти — оддий қидирувдан фойдаланинг.' },
};

/** Optional assistant: shown only when the owner enabled `ai.enabled`. Never blocks search/checkout. */
export function AiAssistant() {
  const { lang } = useI18n();
  const t = MSG[lang] ?? MSG['uz-Latn']!;
  const [enabled, setEnabled] = useState(false);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api('/features').then((f) => setEnabled(Boolean(f['ai.enabled']))).catch(() => setEnabled(false)); }, []);
  if (!enabled) return null;
  const answer = res && (res.answer_text ?? (res.answer_key === 'ai.found_products' ? t.found : res.answer_key === 'ai.nothing_within_budget' ? t.budget : res.answer_key === 'ai.need_more_detail' ? t.detail : t.none));
  return (
    <section className="card" style={{ margin: '12px 0' }} aria-labelledby="ai-title">
      <h2 id="ai-title" style={{ marginTop: 0 }}>{t.title}</h2>
      <form className="row" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true); setErr(null); setRes(null);
        try { setRes(await api('/ai/shopping', { method: 'POST', body: { message: q, locale: lang } })); } catch { setErr(t.off); } finally { setBusy(false); }
      }}>
        <label htmlFor="ai-q" className="sr-only">{t.title}</label>
        <input id="ai-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t.ph} style={{ flex: 1, minWidth: 180 }} maxLength={500} />
        <button className="btn" disabled={busy || q.trim().length < 2}>{t.ask}</button>
      </form>
      {err && <p role="alert" className="notice">{err}</p>}
      {res && (
        <div aria-live="polite" style={{ marginTop: 8 }}>
          <p>{answer}</p>
          <div className="grid">
            {res.products.map((p: any) => (
              <Link key={p.product_id} href={`/p/${p.slug}`} className="card" style={{ textDecoration: 'none', color: 'inherit' }}>
                <div style={{ fontWeight: 600 }}>{pick(p.name, lang)}</div>
                <div>{som(p.price.amount_minor)}</div>
              </Link>
            ))}
          </div>
          <p className="muted" style={{ fontSize: 14 }}>{t.note} <span className="badge">{res.provider === 'anthropic' ? 'Claude' : 'katalog'}</span></p>
        </div>
      )}
    </section>
  );
}
