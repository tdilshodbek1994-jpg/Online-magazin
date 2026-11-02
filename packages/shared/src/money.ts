/**
 * Money: integer minor units (BIGINT in DB, decimal string in JSON). Never floating point.
 * MASTER 8.5, ADR-004. For UZS minor unit = tiyin (1 so'm = 100 tiyin).
 */
export type Currency = 'UZS' | 'USD' | 'EUR' | 'RUB';

export const MINOR_DIGITS: Record<Currency, number> = { UZS: 2, USD: 2, EUR: 2, RUB: 2 };

export interface MoneyJson {
  amount_minor: string;
  currency: Currency;
}

export interface Money {
  amountMinor: bigint;
  currency: Currency;
}

const INT_RE = /^-?\d+$/;

export function money(amountMinor: bigint | number | string, currency: Currency = 'UZS'): Money {
  if (typeof amountMinor === 'number') {
    if (!Number.isSafeInteger(amountMinor)) throw new MoneyError('MONEY_NOT_SAFE_INTEGER');
    return { amountMinor: BigInt(amountMinor), currency };
  }
  if (typeof amountMinor === 'string') {
    if (!INT_RE.test(amountMinor)) throw new MoneyError('MONEY_INVALID_STRING');
    return { amountMinor: BigInt(amountMinor), currency };
  }
  return { amountMinor, currency };
}

/** Convenience for whole so'm values in fixtures/tests: som(100_000) = 10_000_000 tiyin. */
export function som(whole: number | bigint): Money {
  return money(BigInt(whole) * 100n, 'UZS');
}

export class MoneyError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

export function toJson(m: Money): MoneyJson {
  return { amount_minor: m.amountMinor.toString(), currency: m.currency };
}

export function fromJson(j: MoneyJson): Money {
  return money(j.amount_minor, j.currency);
}

function same(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new MoneyError('CURRENCY_MISMATCH');
}

export function add(a: Money, b: Money): Money {
  same(a, b);
  return { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency };
}

export function sub(a: Money, b: Money): Money {
  same(a, b);
  return { amountMinor: a.amountMinor - b.amountMinor, currency: a.currency };
}

export function sum(items: Money[], currency: Currency = 'UZS'): Money {
  return items.reduce((acc, m) => add(acc, m), money(0n, currency));
}

export function mulQty(m: Money, qty: number | bigint): Money {
  const q = BigInt(qty);
  return { amountMinor: m.amountMinor * q, currency: m.currency };
}

/** Round half up (away from zero for positives) a rational n/d to integer. d > 0. */
export function divRoundHalfUp(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new MoneyError('DIVISOR_NOT_POSITIVE');
  const neg = n < 0n;
  const a = neg ? -n : n;
  const q = a / d;
  const r = a % d;
  const res = r * 2n >= d ? q + 1n : q;
  return neg ? -res : res;
}

/** Percentage expressed in basis points (30% = 3000 bps). Half-up rounding to minor unit. */
export function percentBps(m: Money, bps: number | bigint): Money {
  return { amountMinor: divRoundHalfUp(m.amountMinor * BigInt(bps), 10_000n), currency: m.currency };
}

/**
 * Allocate `total` across `weights` proportionally (MASTER 9.2, DEC-005):
 * floor each exact share, then distribute remaining units by largest fractional remainder,
 * ties broken by stable key order (ascending). Sum always equals total, no share negative.
 */
export function allocateLargestRemainder(
  total: bigint,
  items: { key: string; weight: bigint }[],
): Map<string, bigint> {
  if (total < 0n) throw new MoneyError('ALLOCATION_NEGATIVE_TOTAL');
  const out = new Map<string, bigint>();
  const totalWeight = items.reduce((a, i) => a + i.weight, 0n);
  if (items.some((i) => i.weight < 0n)) throw new MoneyError('ALLOCATION_NEGATIVE_WEIGHT');
  if (totalWeight === 0n) {
    if (total !== 0n) throw new MoneyError('ALLOCATION_ZERO_WEIGHT');
    items.forEach((i) => out.set(i.key, 0n));
    return out;
  }
  if (total > totalWeight) throw new MoneyError('ALLOCATION_EXCEEDS_BASE');
  let allocated = 0n;
  const rema: { key: string; rem: bigint }[] = [];
  for (const i of items) {
    const exact = total * i.weight;
    const share = exact / totalWeight;
    out.set(i.key, share);
    allocated += share;
    rema.push({ key: i.key, rem: exact % totalWeight });
  }
  let left = total - allocated;
  rema.sort((a, b) => (a.rem === b.rem ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : a.rem > b.rem ? -1 : 1));
  for (const r of rema) {
    if (left === 0n) break;
    out.set(r.key, (out.get(r.key) ?? 0n) + 1n);
    left -= 1n;
  }
  return out;
}

/** Human display, e.g. "100 000 so'm" / "100 000,50 сўм". Locale-specific suffix handled by caller. */
export function formatAmount(m: Money): string {
  const digits = MINOR_DIGITS[m.currency];
  const base = 10n ** BigInt(digits);
  const neg = m.amountMinor < 0n;
  const abs = neg ? -m.amountMinor : m.amountMinor;
  const whole = (abs / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const frac = abs % base;
  const fracStr = frac === 0n ? '' : ',' + frac.toString().padStart(digits, '0');
  return (neg ? '-' : '') + whole + fracStr;
}
