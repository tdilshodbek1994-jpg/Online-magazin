'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCartCount } from '@/components/Header';
import { IconBag, IconCart, IconGrid, IconHome, IconPlay, IconStore, IconUser, IconWallet } from '@/components/Icons';
import { api, getToken } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useEffect, useState } from 'react';

export const isStaffPath = (p: string) => /^\/(admin|ops|courier)(\/|$)/.test(p);
export const isWorkPath = (p: string) => p.startsWith('/partner') || p.startsWith('/tg/') || p === '/app' || isStaffPath(p);

/** Mobile bottom navigation (hidden on desktop by CSS). */
export function BottomNav() {
  const { t } = useI18n();
  const path = usePathname() ?? '/';
  const count = useCartCount();
  const [logged, setLogged] = useState(false);
  useEffect(() => { setLogged(!!getToken()); }, [path]);
  if (path.startsWith('/tg/') || path === '/app') return null;
  if (path.startsWith('/partner')) {
    // V2 §02: five things a partner does daily. Owner (2026-11-05): the big middle button opens the AI assistant;
    // a new customer order starts from «Buyurtmalar» (+ Buyurtma) and the home page.
    const pItems: [string, string, React.ReactNode, boolean][] = [
      ['/partner', 'Bosh sahifa', <IconHome key="d" />, path === '/partner'],
      ['/partner/orders', 'Buyurtmalar', <IconBag key="o" />, path.startsWith('/partner/orders') || path.startsWith('/partner/requests')],
      ['/partner/ai', 'AI yordamchi', <span key="n" className="bn-plus bn-ai" aria-hidden>🤖</span>, path.startsWith('/partner/ai')],
      ['/partner/market', 'Mahsulotlar', <IconStore key="m" />, path.startsWith('/partner/market') || path.startsWith('/partner/streams')],
      ['/partner/wallet', 'Hamyon', <IconWallet key="w" />, path.startsWith('/partner/wallet') || path.startsWith('/partner/payouts')],
    ];
    return (
      <nav className="bottom-nav five" aria-label="Hamkor menyusi">
        {pItems.map(([href, label, icon, on]) => (
          <Link key={href} href={href} className={`${on ? 'on' : ''} ${href === '/partner/ai' ? 'bn-cta' : ''}`} aria-current={on ? 'page' : undefined}><span className="bn-icon">{icon}</span><span>{href === '/partner/ai' ? 'AI' : label}</span></Link>
        ))}
      </nav>
    );
  }
  // Staff work areas have their own navigation; the shop's bottom bar only gets in the way there.
  if (isStaffPath(path)) return null;
  const items: [string, string, React.ReactNode, boolean][] = [
    ['/', t('home'), <IconHome key="h" />, path === '/'],
    ['/catalog', t('catalog'), <IconGrid key="g" />, path.startsWith('/catalog') || path.startsWith('/p/')],
    ['/reels', 'Video', <IconPlay key="v" />, path.startsWith('/reels')],
    ['/cart', t('cart'), <IconCart key="c" />, path.startsWith('/cart') || path.startsWith('/checkout')],
    [logged ? '/account' : '/login', t('account'), <IconUser key="u" />, path.startsWith('/account') || path.startsWith('/login')],
  ];
  return (
    <nav className="bottom-nav five-main" aria-label={t('catalog')}>
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
  const path = usePathname() ?? '/';
  const [demo, setDemo] = useState(false);
  useEffect(() => { api('/features').then((f) => setDemo(!!f.demo)).catch(() => {}); }, []);
  if (isWorkPath(path)) return null;
  return (
    <footer className="site-foot">
      <div className="wrap foot-grid">
        <div>
          <div className="brand"><span className="logo-mark"><IconBag size={20} /></span><span>Uz<b>Shop</b></span></div>
          <p className="muted">{t('aboutShop')}</p>
          {demo && <p className="badge test">{t('demoNote')}</p>}
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
