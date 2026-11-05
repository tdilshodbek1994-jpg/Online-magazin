'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { CategoryIcon } from '@/components/Icons';
import { api } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';

/** "☰ Katalog" next to the search: a top-down list of categories (all pages). Closes on choice, outside tap, Esc. */
export function CatalogMenu() {
  const { lang } = useI18n();
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const [cats, setCats] = useState<any[]>([]);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { api('/categories').then((c) => { const all = c.items ?? []; const tops = all.filter((x: any) => !x.parent_id); setCats(tops.flatMap((t: any) => [t, ...all.filter((x: any) => x.parent_id === t.id).map((x: any) => ({ ...x, sub: true }))])); }).catch(() => {}); }, []);
  useEffect(() => { setOpen(false); }, [path]);
  useEffect(() => {
    if (!open) return;
    const out = (e: Event) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', out); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', out); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div className="catmenu" ref={box}>
      <button type="button" className="catmenu-btn" aria-label="Katalog" aria-expanded={open} aria-controls="catmenu-list" onClick={() => setOpen(!open)}>
        <span aria-hidden>{open ? '✕' : '☰'}</span><span className="catmenu-label">Katalog</span>
      </button>
      {open && (
        <div id="catmenu-list" className="catmenu-pop" role="menu" aria-label="Toifalar">
          <Link role="menuitem" href="/catalog" className="catmenu-item all" onClick={() => setOpen(false)}><span className="cm-ico" aria-hidden>🛍️</span>Barcha mahsulotlar</Link>
          {cats.map((c) => (
            <Link role="menuitem" key={c.id} href={`/catalog?category=${c.slug}`} className={`catmenu-item ${c.sub ? 'sub' : ''}`} onClick={() => setOpen(false)}>
              <span className="cm-ico" aria-hidden><CategoryIcon slug={c.slug} size={20} /></span>
              <span className="cm-name">{pick(c.name, lang)}</span>
              {c.product_count ? <small className="muted">{c.product_count}</small> : null}
              <span className="cm-go" aria-hidden>›</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
