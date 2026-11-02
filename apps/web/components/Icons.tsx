import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };
const base = ({ size = 22, ...p }: P) => ({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true, ...p });

export const IconSearch = (p: P) => <svg {...base(p)}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>;
export const IconCart = (p: P) => <svg {...base(p)}><path d="M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.5L21 8H6.2" /><circle cx="10" cy="20" r="1.3" /><circle cx="17" cy="20" r="1.3" /></svg>;
export const IconUser = (p: P) => <svg {...base(p)}><circle cx="12" cy="8" r="4" /><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" /></svg>;
export const IconHome = (p: P) => <svg {...base(p)}><path d="m3 11 9-7 9 7" /><path d="M5 10v10h14V10" /><path d="M10 20v-6h4v6" /></svg>;
export const IconGrid = (p: P) => <svg {...base(p)}><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></svg>;
export const IconTruck = (p: P) => <svg {...base(p)}><path d="M3 6h11v10H3z" /><path d="M14 9h4l3 3v4h-7" /><circle cx="7" cy="18" r="1.8" /><circle cx="17" cy="18" r="1.8" /></svg>;
export const IconCash = (p: P) => <svg {...base(p)}><rect x="2.5" y="6" width="19" height="12" rx="2" /><circle cx="12" cy="12" r="2.6" /><path d="M6 9.5v5M18 9.5v5" /></svg>;
export const IconShield = (p: P) => <svg {...base(p)}><path d="M12 3 4.5 6v5.5c0 4.5 3.2 8 7.5 9.5 4.3-1.5 7.5-5 7.5-9.5V6z" /><path d="m9 12 2 2 4-4" /></svg>;
export const IconReturn = (p: P) => <svg {...base(p)}><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></svg>;
export const IconChevron = (p: P) => <svg {...base(p)}><path d="m9 6 6 6-6 6" /></svg>;
export const IconPlus = (p: P) => <svg {...base(p)}><path d="M12 5v14M5 12h14" /></svg>;
export const IconMinus = (p: P) => <svg {...base(p)}><path d="M5 12h14" /></svg>;
export const IconCheck = (p: P) => <svg {...base(p)}><path d="m5 12 4.5 4.5L19 7" /></svg>;
export const IconBag = (p: P) => <svg {...base(p)}><path d="M5 8h14l-1 12H6z" /><path d="M9 8V6.5a3 3 0 0 1 6 0V8" /></svg>;

/** Category pictograms by slug; unknown slugs get a generic bag. */
export function CategoryIcon({ slug, size = 28 }: { slug: string; size?: number }) {
  const p = base({ size, strokeWidth: 1.6 });
  switch (slug) {
    case 'elektronika': return <svg {...p}><rect x="3" y="5" width="18" height="12" rx="2" /><path d="M8 21h8M12 17v4" /></svg>;
    case 'smartfonlar': return <svg {...p}><rect x="7" y="2.5" width="10" height="19" rx="2.5" /><path d="M11 18.5h2" /></svg>;
    case 'quloqchinlar': return <svg {...p}><path d="M4 15v-3a8 8 0 0 1 16 0v3" /><rect x="3" y="14" width="4" height="6" rx="1.5" /><rect x="17" y="14" width="4" height="6" rx="1.5" /></svg>;
    case 'noutbuklar': return <svg {...p}><rect x="5" y="5" width="14" height="10" rx="1.5" /><path d="M2.5 19h19l-1.5-4h-16z" /></svg>;
    case 'uy-rozgor': return <IconHome size={size} strokeWidth={1.6} />;
    case 'oshxona': return <svg {...p}><path d="M6 10h12v7a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3z" /><path d="M18 12h2a1.5 1.5 0 0 1 0 3h-2M9 4c0 1.5 1 1.5 1 3M13 4c0 1.5 1 1.5 1 3" /></svg>;
    case 'kiyim-poyabzal': return <svg {...p}><path d="M8 3 3.5 6 5 10l2-1v12h10V9l2 1 1.5-4L16 3c-.5 2-2 3-4 3s-3.5-1-4-3z" /></svg>;
    case 'gozallik': return <svg {...p}><rect x="7" y="9" width="10" height="12" rx="3" /><path d="M10 9V6h4v3M11 3h2" /></svg>;
    case 'sport': return <svg {...p}><circle cx="12" cy="12" r="9" /><path d="M3.5 9.5c4 1 8 4 9 11M20.5 14.5c-4-1-8-4-9-11" /></svg>;
    default: return <IconBag size={size} strokeWidth={1.6} />;
  }
}
