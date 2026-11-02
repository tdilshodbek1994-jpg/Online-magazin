import { describe, expect, it } from 'vitest';
import { allocateLargestRemainder, divRoundHalfUp, formatAmount, money, percentBps, som, toJson } from './money.js';

describe('Money (ADR-004, AC-M54-2)', () => {
  it('serializes as decimal string without precision loss', () => {
    const big = money('900719925474099312345');
    expect(toJson(big).amount_minor).toBe('900719925474099312345');
    expect(() => money(0.1 as number)).toThrow();
  });
  it('100 000 so\'m = 10 000 000 tiyin (MASTER 8.5)', () => {
    expect(toJson(som(100_000))).toEqual({ amount_minor: '10000000', currency: 'UZS' });
  });
  it('30% of 100 000 = 30 000 (9.3 fixture)', () => {
    expect(percentBps(som(100_000), 3000)).toEqual(som(30_000));
  });
  it('half-up rounding', () => {
    expect(divRoundHalfUp(5n, 2n)).toBe(3n);
    expect(divRoundHalfUp(4n, 3n)).toBe(1n);
    expect(divRoundHalfUp(-5n, 2n)).toBe(-3n);
  });
  it('formats with thin grouping', () => {
    expect(formatAmount(som(100_000))).toBe('100 000');
    expect(formatAmount(money(10_050))).toBe('100,50');
  });
});

describe('Discount allocation (MASTER 9.2, AC-M12-2, AC-X09)', () => {
  it('3 lines: sum equals total, deterministic', () => {
    const r = allocateLargestRemainder(1000n, [
      { key: 'a', weight: 333n },
      { key: 'b', weight: 333n },
      { key: 'c', weight: 334n },
    ]);
    expect([...r.values()].reduce((a, b) => a + b, 0n)).toBe(1000n);
    expect(r.get('c')).toBe(334n);
  });
  it('999 eligible lines with tiny discount: no tiyin lost, no negative net, repeatable', () => {
    const items = Array.from({ length: 999 }, (_, i) => ({ key: `l${String(i).padStart(4, '0')}`, weight: BigInt(100 + (i % 7)) }));
    const r1 = allocateLargestRemainder(500n, items);
    const r2 = allocateLargestRemainder(500n, [...items].reverse());
    const total = [...r1.values()].reduce((a, b) => a + b, 0n);
    expect(total).toBe(500n);
    for (const it of items) {
      expect(r1.get(it.key)!).toBeGreaterThanOrEqual(0n);
      expect(r1.get(it.key)! <= it.weight).toBe(true);
      expect(r1.get(it.key)).toBe(r2.get(it.key));
    }
  });
  it('rejects discount larger than base', () => {
    expect(() => allocateLargestRemainder(11n, [{ key: 'a', weight: 10n }])).toThrow();
  });
});
