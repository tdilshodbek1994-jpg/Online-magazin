import { divRoundHalfUp } from '@om/shared';
import type { Queryable } from '../../platform/db.js';

/**
 * Exact money helpers for the ad/commission analytics (spec §12): no binary floats anywhere.
 * Amounts are integer minor units (tiyin / cents); FX rates are decimals scaled to 1e6.
 * Normalisation: amount_uzs = amount_original × Rate / Nominal (Central Bank fields).
 */
export const RATE_SCALE = 1_000_000n;

/** "123.45" → 12345n (scale = number of decimals kept). Rejects anything that is not a plain decimal. */
export function decToScaled(s: string, scale: number): bigint {
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(String(s).trim());
  if (!m) throw new Error(`bad decimal: ${s}`);
  const frac = (m[3] ?? '').padEnd(scale, '0');
  if (frac.length > scale && /[1-9]/.test(frac.slice(scale))) throw new Error(`too many decimals: ${s}`);
  const v = BigInt(m[2]! + frac.slice(0, scale));
  return m[1] ? -v : v;
}
export const scaledToDec = (v: bigint, scale: number) => {
  const neg = v < 0n; const a = neg ? -v : v; const s = a.toString().padStart(scale + 1, '0');
  return `${neg ? '-' : ''}${s.slice(0, -scale)}${scale ? '.' + s.slice(-scale) : ''}`;
};

/** original minor units (×100) → UZS tiyin, half-up. */
export function toUzsMinor(originalMinor: bigint, rate: string, nominal: number): bigint {
  return divRoundHalfUp(originalMinor * decToScaled(rate, 6), BigInt(nominal) * RATE_SCALE);
}
/** UZS tiyin → USD cents at a given USD rate (display equivalent, not a real dollar receipt). */
export function uzsToUsdCents(uzsMinor: bigint, rate: string, nominal: number): bigint {
  return divRoundHalfUp(uzsMinor * BigInt(nominal) * RATE_SCALE, decToScaled(rate, 6));
}

export interface FxPick { rate: string; nominal: number; date: string; source: string }
/**
 * Latest official rate on or before `date` (bank_actual > cbu > manual for the same day). Never "1" when missing:
 * the caller marks the row FX_PENDING. The effective date returned may be earlier than requested and is shown.
 */
export async function fxFor(q: Queryable, currency: string, date: string): Promise<FxPick | null> {
  if (currency === 'UZS') return { rate: '1', nominal: 1, date, source: 'identity' };
  const r = await q.query(
    `SELECT rate::text, nominal, effective_date::text AS date, source FROM fx_snapshots WHERE currency=$1 AND effective_date <= $2::date
      ORDER BY effective_date DESC, CASE source WHEN 'bank_actual' THEN 0 WHEN 'cbu' THEN 1 ELSE 2 END LIMIT 1`, [currency, date]);
  return r.rows[0] ?? null;
}

/** A cache of USD rates by day for converting many dated items (each at its own date). */
export async function usdRates(q: Queryable, from: string, to: string): Promise<(date: string) => FxPick | null> {
  const r = await q.query(
    `SELECT rate::text, nominal, effective_date::text AS date, source FROM fx_snapshots WHERE currency='USD' AND effective_date <= $2::date
      AND effective_date >= (SELECT COALESCE(MAX(effective_date), $1::date) FROM fx_snapshots WHERE currency='USD' AND effective_date <= $1::date)
      ORDER BY effective_date, CASE source WHEN 'bank_actual' THEN 0 WHEN 'cbu' THEN 1 ELSE 2 END DESC`, [from, to]);
  const rows = r.rows as FxPick[];
  return (date: string) => {
    let best: FxPick | null = null;
    for (const x of rows) if (x.date <= date) best = x; else break;
    return best;
  };
}

/** CSV cell that can never execute as a spreadsheet formula (spec §21). */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
