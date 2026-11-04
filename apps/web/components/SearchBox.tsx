'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { IconSearch } from '@/components/Icons';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';

/**
 * Header search with live suggestions: after 2 letters (debounced) the shopper sees matching products with photo
 * and price, plus matching categories — typos included (the API falls back to similar products).
 * Keyboard: ↑/↓ to move, Enter to open, Esc to close. Enter with nothing selected runs the full search.
 */
export function SearchBox() {
  const { t, lang } = useI18n();
  const router = useRouter();
  const path = usePathname();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<any[]>([]);
  const [cats, setCats] = useState<any[]>([]);
  const [allCats, setAllCats] = useState<any[]>([]);
  const [fuzzy, setFuzzy] = useState(false);
  const [active, setActive] = useState(-1);
  const box = useRef<HTMLFormElement>(null);
  const seq = useRef(0);

  useEffect(() => { try { setQ(new URLSearchParams(location.search).get('q') ?? ''); } catch {} setOpen(false); }, [path]);
  useEffect(() => { api('/categories').then((c) => setAllCats(c.items ?? [])).catch(() => {}); }, []);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setItems([]); setCats([]); return; }
    const n = ++seq.current;
    const tm = setTimeout(() => {
      api(`/products?limit=6&q=${encodeURIComponent(term)}`).then((r) => { if (n === seq.current) { setItems(r.items ?? []); setFuzzy(!!r.fuzzy); setActive(-1); } }).catch(() => {});
      const low = term.toLowerCase();
      setCats(allCats.filter((c) => Object.values(c.name ?? {}).some((v: any) => String(v).toLowerCase().includes(low))).slice(0, 3));
    }, 220);
    return () => clearTimeout(tm);
  }, [q, allCats]);
  useEffect(() => {
    const out = (e: Event) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', out);
    return () => document.removeEventListener('pointerdown', out);
  }, []);

  const links = [...cats.map((c) => `/catalog?category=${c.slug}`), ...items.map((p) => `/p/${p.slug}`)];
  const go = (href: string) => { setOpen(false); router.push(href); };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (active >= 0 && links[active]) return go(links[active]!);
    go(q.trim() ? `/catalog?q=${encodeURIComponent(q.trim())}` : '/catalog');
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { setOpen(false); return; }
    if (!links.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => (a + 1) % links.length); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a <= 0 ? links.length - 1 : a - 1)); }
  };
  const show = open && q.trim().length >= 2 && (items.length > 0 || cats.length > 0);
  return (
    <form ref={box} className="search sbox" role="search" onSubmit={submit}>
      <label htmlFor="q" className="sr-only">{t('search')}</label>
      <input id="q" type="search" value={q} autoComplete="off" placeholder={t('searchPh')}
        role="combobox" aria-expanded={show} aria-controls="q-suggest" aria-autocomplete="list" aria-activedescendant={active >= 0 ? `qs-${active}` : undefined}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onKeyDown={onKey} />
      <button type="submit" className="search-btn" aria-label={t('search')}><IconSearch size={20} /><span className="sb-text" aria-hidden>{t('search')}</span></button>
      {show && (
        <div id="q-suggest" className="suggest" role="listbox" aria-label="Takliflar">
          {fuzzy && <div className="sg-note">Aniq topilmadi — o‘xshashlari:</div>}
          {cats.map((c, i) => (
            <Link key={c.id} id={`qs-${i}`} role="option" aria-selected={active === i} href={links[i]!} className={`sg-row sg-cat ${active === i ? 'on' : ''}`} onClick={() => setOpen(false)}>
              <span className="sg-ico" aria-hidden>🗂️</span><span>{pick(c.name, lang)}</span><small className="muted">toifa</small>
            </Link>
          ))}
          {items.map((p, j) => {
            const i = cats.length + j;
            return (
              <Link key={p.id} id={`qs-${i}`} role="option" aria-selected={active === i} href={links[i]!} className={`sg-row ${active === i ? 'on' : ''}`} onClick={() => setOpen(false)}>
                {p.image ? <img src={p.image} alt="" width={40} height={40} /> : <span className="sg-ico" aria-hidden>🛍️</span>}
                <span className="sg-name">{pick(p.name, lang)}{p.available <= 0 && <small className="muted"> · tugagan</small>}</span>
                {p.min_price && <b className="sg-price">{som(p.min_price.amount_minor)}</b>}
              </Link>
            );
          })}
          <button type="submit" className="sg-all">“{q.trim()}” bo‘yicha barcha natijalar →</button>
        </div>
      )}
    </form>
  );
}
