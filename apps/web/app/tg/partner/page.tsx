import type { Metadata } from 'next';
import { TgEntry } from '@/components/TgEntry';

export const metadata: Metadata = { title: 'UzShop — hamkor kabineti', robots: { index: false, follow: false } };

/** Telegram Mini App entry for the partner bot. BotFather → Configure Mini App / menu button URL: https://<domain>/tg/partner */
export default function TgPartner() {
  return <TgEntry app="partner" />;
}
