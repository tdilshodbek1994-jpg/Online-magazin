import type { Metadata } from 'next';
import './globals.css';
import { Header } from '@/components/Header';
import { I18nProvider } from '@/lib/i18n';

export const metadata: Metadata = { title: 'Online Magazin', description: 'Online Magazin — mahsulotlar katalogi' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="uz">
      <body>
        <I18nProvider>
          <Header />
          <main className="wrap">{children}</main>
        </I18nProvider>
      </body>
    </html>
  );
}
