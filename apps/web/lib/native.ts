'use client';
/** Android app (Capacitor shell, user agent «UzShopApp/…»). Plugins come from the native bridge, no npm import needed. */
type Cap = { isNativePlatform?: () => boolean; Plugins?: Record<string, any> };
export function cap(): Cap | null {
  if (typeof window === 'undefined') return null;
  return ((window as unknown as { Capacitor?: Cap }).Capacitor) ?? null;
}
export function isNativeApp(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /UzShopApp\//.test(navigator.userAgent) || !!cap()?.isNativePlatform?.();
}

export interface Area { key: 'admin' | 'ops' | 'partner' | 'courier' | 'shop'; href: string; title: string; text: string; icon: string }
/** Work areas a signed-in person may open, from /me (roles + permissions). The shop is always there. */
export function areasFor(me: { roles?: { role: string }[]; permissions?: string[] } | null, isPartner = false): Area[] {
  const roles = (me?.roles ?? []).map((r) => r.role);
  const perms = me?.permissions ?? [];
  const out: Area[] = [];
  if (perms.includes('catalog.write') || perms.includes('reports.read') || perms.includes('payouts.prepare')) out.push({ key: 'admin', href: '/admin', title: 'Boshqaruv', text: 'Hisobotlar, mahsulotlar, xodimlar, pul', icon: '📊' });
  if (perms.includes('orders.read_all')) out.push({ key: 'ops', href: '/ops', title: 'Operator', text: 'Buyurtmalar navbati, qo‘ng‘iroqlar', icon: '🎧' });
  // Partners are not staff grants: the caller passes whether /partner/me exists.
  if (isPartner || roles.includes('partner')) out.push({ key: 'partner', href: '/partner', title: 'Hamkor', text: 'Buyurtmalar, hamyon, mahsulotlar, AI', icon: '🤝' });
  if (roles.includes('courier')) out.push({ key: 'courier', href: '/courier', title: 'Kuryer', text: 'Yetkazishlar', icon: '🚚' });
  out.push({ key: 'shop', href: '/', title: 'Do‘kon', text: 'Xarid qilish, buyurtmalarim', icon: '🛍️' });
  return out;
}
export const AREA_KEY = 'om_app_area';
