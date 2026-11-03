'use client';
import { som } from '@/lib/api';

export const CH_LABEL: Record<string, string> = { telegram_channel: 'Telegram kanal', telegram_ads: 'Telegram Ads', instagram_target: 'Instagram target', meta_mixed: 'Meta (aralash)', organic: 'Organik', unknown: 'Manba ajratilmagan', other: 'Boshqa' };
export const PERIODS: [string, string][] = [['today', 'Bugun'], ['yesterday', 'Kecha'], ['this_week', 'Shu hafta'], ['last_week', 'O‘tgan hafta'], ['this_month', 'Shu oy'], ['last_month', 'O‘tgan oy'], ['this_year', 'Shu yil'], ['last_year', 'O‘tgan yil'], ['custom', 'Oraliq']];

/** Money in the report currency: UZS tiyin → so'm, USD cents → $ (USD is a display equivalent, not a real dollar receipt). */
export function useMoney(currency: string) {
  return (v: string | null | undefined, missing = 'Kiritilmagan') => {
    if (v === null || v === undefined) return missing;
    if (currency === 'USD') { const n = Number(v) / 100; return `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
    return BigInt(v) < 0n ? `−${som((-BigInt(v)).toString())}` : som(v);
  };
}

