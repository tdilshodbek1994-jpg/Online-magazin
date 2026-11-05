import type { Metadata } from 'next';
import { TgEntry } from '@/components/TgEntry';

export const metadata: Metadata = { title: 'UzShop — operator xonasi', robots: { index: false, follow: false } };

/** Telegram Mini App entry for the operator bot. Menu button URL: https://<domain>/tg/operator */
export default function TgOperator() {
  return <TgEntry app="operator" />;
}
