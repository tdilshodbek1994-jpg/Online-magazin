import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Header } from '@/components/Header';
import { BottomNav, Footer } from '@/components/Shell';
import { I18nProvider } from '@/lib/i18n';

export const metadata: Metadata = { title: 'UzShop — onlayn do‘kon', description: 'UzShop — elektronika, uy-ro‘zg‘or, kiyim va boshqa mahsulotlar. To‘lov qabul qilganda.' };
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
        </I18nProvider>
      </body>
    </html>
  );
}
