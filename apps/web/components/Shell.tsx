'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCartCount } from '@/components/Header';
import { IconBag, IconCart, IconGrid, IconHome, IconUser } from '@/components/Icons';
import { getToken } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useEffect, useState } from 'react';

/** Mobile bottom navigation (hidden on desktop by CSS). */
export function BottomNav() {
  const { t } = useI18n();
  const path = usePathname() ?? '/';
  const count = useCartCount();
  const [logged, setLogged] = useState(false);
  useEffect(() => { setLogged(!!getToken()); }, [path]);
  const items: [string, string, React.ReactNode, boolean][] = [
    ['/', t('home'), <IconHome key="h" />, path === '/'],
    ['/catalog', t('catalog'), <IconGrid key="g" />, path.startsWith('/catalog') || path.startsWith('/p/')],
    ['/cart', t('cart'), <IconCart key="c" />, path.startsWith('/cart') || path.startsWith('/checkout')],
    [logged ? '/account' : '/login', t('account'), <IconUser key="u" />, path.startsWith('/account') || path.startsWith('/login')],
  ];
  return (
    <nav className="bottom-nav" aria-label={t('catalog')}>
      {items.map(([href, label, icon, on]) => (
        <Link key={href} href={href} className={on ? 'on' : ''} aria-current={on ? 'page' : undefined}>
          <span className="bn-icon">{icon}{href === '/cart' && count > 0 && <span className="count" aria-hidden>{count > 99 ? '99+' : count}</span>}</span>
          <span>{label}</span>
        </Link>
      ))}
    </nav>
  );
}

export function Footer() {
  const { t } = useI18n();
  return (
    <footer className="site-foot">
      <div className="wrap foot-grid">
        <div>
          <div className="brand"><span className="logo-mark"><IconBag size={20} /></span><span>Uz<b>Shop</b></span></div>
          <p className="muted">{t('aboutShop')}</p>
          <p className="badge test">{t('demoNote')}</p>
        </div>
        <div>
          <h3>{t('catalog')}</h3>
          <Link href="/catalog?category=elektronika">Elektronika</Link>
          <Link href="/catalog?category=uy-rozgor">Uy-ro‘zg‘or</Link>
          <Link href="/catalog?category=kiyim-poyabzal">Kiyim va poyabzal</Link>
        </div>
        <div>
          <h3>{t('help')}</h3>
          <Link href="/legal/returns">{t('returns')}</Link>
          <Link href="/legal/offer">Ommaviy oferta</Link>
          <Link href="/legal/privacy">Maxfiylik siyosati</Link>
        </div>
      </div>
      <div className="wrap foot-copy muted">© {new Date().getFullYear()} UzShop</div>
    </footer>
  );
}
