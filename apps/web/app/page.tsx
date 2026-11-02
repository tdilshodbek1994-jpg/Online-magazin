'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Async } from '@/components/Header';
import { AiAssistant } from '@/components/AiAssistant';
import { api, som } from '@/lib/api';
import { pick, useI18n } from '@/lib/i18n';

export default function Home() {
  const { t, lang } = useI18n();
  const [q, setQ] = useState('');
  const [items, setItems] = useState<any[]>([]);
  const [state, setState] = useState<{ loading: boolean; error: any }>({ loading: true, error: null });
  const load = useCallback(async (query: string) => {
    setState({ loading: true, error: null });
    try {
      const r = await api(`/products?limit=48${query ? `&q=${encodeURIComponent(query)}` : ''}`);
      setItems(r.items);
      setState({ loading: false, error: null });
    } catch (e) { setState({ loading: false, error: e }); }
  }, []);
  useEffect(() => { void load(''); }, [load]);
  return (
    <>
      <form className="row" role="search" onSubmit={(e) => { e.preventDefault(); void load(q); }}>
        <label htmlFor="q" className="sr-only">{t('search')}</label>
        <input id="q" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('searchPh')} style={{ flex: 1, minWidth: 180 }} />
        <button className="btn">{t('search')}</button>
        {q && <button type="button" className="btn secondary" onClick={() => { setQ(''); void load(''); }}>×</button>}
      </form>
      <AiAssistant />
      <Async loading={state.loading} error={state.error} onRetry={() => load(q)}>
        {items.length === 0 ? <p>{t('empty')}</p> : (
          <div className="grid" style={{ marginTop: 16 }}>
            {items.map((p) => (
              <Link key={p.id} href={`/p/${p.slug}`} className="card tile" style={{ textDecoration: 'none', color: 'inherit' }}>
                {p.image ? <img src={p.image} alt="" width={300} height={300} /> : <div className="ph" aria-hidden />}
                <div style={{ fontWeight: 600, marginTop: 8 }}>{pick(p.name, lang)}</div>
                <div>{som(p.min_price?.amount_minor)}</div>
                <div className="muted">{p.available > 0 ? t('inStock') : t('outOfStock')}</div>
              </Link>
            ))}
          </div>
        )}
      </Async>
    </>
  );
}
