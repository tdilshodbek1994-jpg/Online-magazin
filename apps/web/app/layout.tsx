import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Header } from '@/components/Header';
import { Toaster } from '@/components/Toaster';
import { ScrollRestorer } from '@/components/ScrollRestorer';
import { BottomNav, Footer } from '@/components/Shell';
import { I18nProvider } from '@/lib/i18n';
import { InstallApp } from '@/components/InstallApp';
import { ConsentBanner } from '@/components/ConsentBanner';
import { TelegramBridge } from '@/components/TelegramBridge';

export const metadata: Metadata = {
  title: 'UzShop — onlayn do‘kon',
  description: 'UzShop — elektronika, uy-ro‘zg‘or, kiyim va boshqa mahsulotlar. To‘lov qabul qilganda.',
  applicationName: 'UzShop',
  appleWebApp: { capable: true, title: 'UzShop', statusBarStyle: 'default' },
  icons: { icon: [{ url: '/icons/favicon-32.png', sizes: '32x32' }, { url: '/icons/favicon-48.png', sizes: '48x48' }, { url: '/icons/icon-192.png', sizes: '192x192' }], apple: '/icons/apple-touch-icon.png' },
  formatDetection: { telephone: false },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#0b7a55' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="uz">
      <body>
        <I18nProvider>
          <Header />
          <main className="wrap">{children}</main>
          <Footer />
          <BottomNav />
          <InstallApp />
          <ConsentBanner />
          <Toaster />
          <ScrollRestorer />
          <TelegramBridge />
        </I18nProvider>
      </body>
    </html>
  );
}
