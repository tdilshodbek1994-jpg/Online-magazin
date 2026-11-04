import type { MetadataRoute } from 'next';

/** Web app manifest: lets phones install UzShop like an app (home-screen icon, own window, no browser bar). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'UzShop — onlayn do‘kon',
    short_name: 'UzShop',
    description: 'Elektronika, uy-ro‘zg‘or, kiyim va boshqa mahsulotlar. To‘lov mahsulotni olganda.',
    lang: 'uz',
    start_url: '/?source=app',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#ffffff',
    theme_color: '#0b7a55',
    categories: ['shopping'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'Katalog', url: '/catalog?source=app', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
      { name: 'Savat', url: '/cart?source=app', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
      { name: 'Hamkor kabineti', url: '/partner?source=app', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
    ],
  };
}
