'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { IconBag, IconCart, IconPlay, IconSearch, IconUser } from '@/components/Icons';
import { api, getToken, setToken } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

/** Fire after any cart change so the header/bottom-nav badges refresh. */
export const notifyCart = () => { try { window.dispatchEvent(new Event('om-cart')); } catch {} };

export function useCartCount(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const load = () => api('/cart').then((c) => setN((c.lines ?? []).reduce((a: number, l: any) => a + Number(l.qty), 0))).catch(() => {});
    void load();
    window.addEventListener('om-cart', load);
    return () => window.removeEventListener('om-cart', load);
  }, []);
  return n;
}

export function Header() {
  const { t, lang, setLang } = useI18n();
  const router = useRouter();
  const path = usePathname();
  const [perms, setPerms] = useState<string[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [logged, setLogged] = useState(false);
  const [q, setQ] = useState('');
  const count = useCartCount();
  // The partner profile menu is a <details>: it must close after a choice (also when the chosen page is the current
  // one, where the route does not change), on a tap outside, and on Escape — otherwise it stays open over the page.
  const menu = useRef<HTMLDetailsElement>(null);
  const closeMenu = () => { if (menu.current) menu.current.open = false; };
  useEffect(() => { closeMenu(); }, [path]);
  useEffect(() => {
    const out = (e: Event) => { if (menu.current?.open && !menu.current.contains(e.target as Node)) closeMenu(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMenu(); };
    document.addEventListener('pointerdown', out);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', out); document.removeEventListener('keydown', esc); };
  }, []);
  useEffect(() => {
    if (!getToken()) return;
    api('/me').then((m) => { setLogged(true); setPerms(m.permissions); setRoles(m.roles.map((r: any) => r.role)); }).catch((e) => { if (e?.status === 401) setToken(null); }); // network errors/aborts never log the user out
  }, []);
  useEffect(() => {
    try { setQ(new URLSearchParams(location.search).get('q') ?? ''); } catch {}
  }, [path]);
  const staff: [string, string][] = [];
  if (roles.includes('partner')) staff.push(['/partner', t('partner')]);
  if (perms.includes('orders.read_all')) staff.push(['/ops', t('ops')]);
  if (perms.includes('catalog.write') || perms.includes('reports.read') || perms.includes('payouts.prepare')) staff.push(['/admin', t('admin')]);
  if (roles.includes('courier')) staff.push(['/courier', 'Kuryer']);
  if (roles.includes('owner') || roles.includes('finance')) staff.push(['/account/security', 'MFA']);
  const logout = async () => { await api('/auth/logout', { method: 'POST' }).catch(() => {}); setToken(null); location.href = '/'; };
  if (path?.startsWith('/partner')) {
    // V2 §02: the partner cabinet is a work tool — no store search, staff bar or cart; one compact profile menu.
    return (
      <header className="top ptop">
        <div className="wrap ptop-row">
          <Link href="/partner" className="brand" aria-label="Hamkor kabineti">
            <span className="logo-mark"><IconBag size={20} /></span>
            <span>Uz<b>Shop</b> <small className="ptop-sub">Hamkor</small></span>
          </Link>
          <Link href="/partner/new" className="btn sm ptop-new">+ Buyurtma</Link>
          <details className="pmenu" ref={menu}>
            <summary aria-label="Profil menyusi"><IconUser /></summary>
            <div className="pmenu-pop" onClick={(e) => { if ((e.target as HTMLElement).closest('a')) closeMenu(); }}>
              <Link href="/partner/orders" aria-current={path === '/partner/orders' ? 'page' : undefined}>Buyurtmalar</Link>
              <Link href="/partner/analytics" aria-current={path === '/partner/analytics' ? 'page' : undefined}>Reklama va daromad</Link>
              <Link href="/partner/expenses" aria-current={path === '/partner/expenses' ? 'page' : undefined}>Reklama xarajatlari</Link>
              <Link href="/partner/offers" aria-current={path === '/partner/offers' ? 'page' : undefined}>Taklif to‘plami</Link>
              <Link href="/partner/contacts" aria-current={path === '/partner/contacts' ? 'page' : undefined}>Mijozlar daftari</Link>
              <Link href="/partner/streams" aria-current={path === '/partner/streams' ? 'page' : undefined}>Oqimlarim</Link>
              <Link href="/partner/stats" aria-current={path === '/partner/stats' ? 'page' : undefined}>Statistika</Link>
              <Link href="/partner/programs" aria-current={path === '/partner/programs' ? 'page' : undefined}>Konkurs va bonuslar</Link>
              <Link href="/partner/notifications" aria-current={path === '/partner/notifications' ? 'page' : undefined}>Bildirishnomalar</Link>
              <Link href="/partner/about" aria-current={path === '/partner/about' ? 'page' : undefined}>Dastur haqida</Link>
              {staff.filter(([h]) => h !== '/partner').map(([href, label]) => <Link key={href} href={href}>{label}</Link>)}
              <Link href="/">Do‘konga o‘tish</Link>
              <label className="sr-only" htmlFor="plang">Til</label>
              <select id="plang" className="lang" value={lang} onChange={(e) => setLang(e.target.value as any)}>
                <option value="uz-Latn">O‘zbek (lotin)</option>
                <option value="uz-Cyrl">Ўзбек (кирилл)</option>
              </select>
              {logged && <button className="link-btn" onClick={logout}>{t('logout')}</button>}
            </div>
          </details>
        </div>
      </header>
    );
  }
  return (
    <header className="top">
      <div className="wrap head-grid">
        <Link href="/" className="brand" aria-label={t('shop')}>
          <span className="logo-mark"><IconBag size={20} /></span>
          <span>Uz<b>Shop</b></span>
        </Link>
        <form className="search" role="search" onSubmit={(e) => { e.preventDefault(); router.push(q.trim() ? `/catalog?q=${encodeURIComponent(q.trim())}` : '/catalog'); }}>
          <label htmlFor="q" className="sr-only">{t('search')}</label>
          <input id="q" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('searchPh')} autoComplete="off" />
          <button type="submit" className="search-btn" aria-label={t('search')}><IconSearch size={20} /><span className="sb-text" aria-hidden>{t('search')}</span></button>
        </form>
        <nav className="head-actions" aria-label="Asosiy">
          <Link href="/reels" className="icon-link"><IconPlay /><span className="icon-label">Video</span></Link>
          <Link href="/cart" className="icon-link" aria-label={`${t('cart')}${count ? ` (${count})` : ''}`}>
            <IconCart /><span className="icon-label">{t('cart')}</span>
            {count > 0 && <span className="count" aria-hidden>{count > 99 ? '99+' : count}</span>}
          </Link>
          {logged
            ? <Link href="/account" className="icon-link"><IconUser /><span className="icon-label">{t('myOrders')}</span></Link>
            : <Link href="/login" className="icon-link"><IconUser /><span className="icon-label">{t('login')}</span></Link>}
          <label className="sr-only" htmlFor="lang">Til</label>
          <select id="lang" className="lang" value={lang} onChange={(e) => setLang(e.target.value as any)}>
            <option value="uz-Latn">O‘zbek (lotin)</option>
            <option value="uz-Cyrl">Ўзбек (кирилл)</option>
          </select>
        </nav>
      </div>
      {logged && (
        <div className="staff-bar">
          <div className="wrap staff-row">
            {staff.length > 0 && <span className="muted staff-title">{t('staff')}:</span>}
            {staff.map(([href, label]) => <Link key={href} href={href} className={path?.startsWith(href) ? 'on' : ''}>{label}</Link>)}
            <button className="link-btn" onClick={logout}>{t('logout')}</button>
          </div>
        </div>
      )}
    </header>
  );
}

export function Async({ loading, error, onRetry, children }: { loading: boolean; error: any; onRetry?: () => void; children: React.ReactNode }) {
  const { t } = useI18n();
  if (loading) return <div role="status" className="loading"><span className="spinner" aria-hidden />{t('loading')}</div>;
  if (error) return <div role="alert" className="notice">{t('error')}: <code>{error.code ?? 'UNKNOWN'}</code> {onRetry && <button className="btn secondary" onClick={onRetry}>{t('retry')}</button>}</div>;
  return <>{children}</>;
}
