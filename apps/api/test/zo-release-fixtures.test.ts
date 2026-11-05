import { describe, expect, it } from 'vitest';
import { localStartUtc } from '../src/modules/aibiz/dates.js';
import { computeOrderTargets, matrixUnitAmounts, type RuleSnapshot } from '../src/modules/commissions/service.js';

/**
 * Final-release package fixtures (docs/release/business_fixtures.json, SYNTHETIC) checked against THE production
 * functions — no second formula. B07–B13/B16 are covered by existing integration tests (see docs/release/STATUS.md).
 */
const rule = { kind: 'quantity_matrix', rule_id: 'r1', version: 1, rate_bps: null, fixed_minor: '3000000', commission_group: 'g', quantity_matrix: { 1: [10000], 2: [10000, 2500], 3: [10000, 5000, 2500] } } as unknown as RuleSnapshot;
const som = (minor: bigint) => (minor / 100n).toString();
const total = (n: number) => matrixUnitAmounts(rule, n)!.reduce((a, b) => a + b, 0n);
const line = (id: string, qty: number, returned = 0) => ({ id, rule, qty, canceledQty: 0, returnedQty: returned, lineNet: 3_000_000n * BigInt(qty), refundedProduct: 0n });

describe('B01–B06 commission matrix (100% / +25% / +50%+25%)', () => {
  it('B01–B03: 1 → 30 000, 2 → 37 500, 3 → 52 500', () => {
    expect([som(total(1)), som(total(2)), som(total(3))]).toEqual(['30000', '37500', '52500']);
  });
  it('4+ units: no approved rule → null (review), never an invented formula', () => {
    expect(matrixUnitAmounts(rule, 4)).toBeNull();
  });
  it('B04/B05: return reprices on retained units (3→2: 52 500→37 500 = −15 000; 2→1: −7 500)', () => {
    const before3 = computeOrderTargets([line('a', 3)]).get('a')!.target;
    const after3 = computeOrderTargets([line('a', 3, 1)]).get('a')!.target;
    expect([som(before3), som(after3), som(after3 - before3)]).toEqual(['52500', '37500', '-15000']);
    const before2 = computeOrderTargets([line('b', 2)]).get('b')!.target;
    const after2 = computeOrderTargets([line('b', 2, 1)]).get('b')!.target;
    expect(som(after2 - before2)).toBe('-7500');
  });
  it('a group split over two lines never pays the 100% unit twice', () => {
    const t = computeOrderTargets([line('x', 1), line('y', 2)]);
    expect(som(t.get('x')!.target + t.get('y')!.target)).toBe('52500');
  });
  it('B06: 36 one-unit + 20 two-unit orders = 56 orders, 76 units, 1 830 000', () => {
    const sum = 36n * total(1) + 20n * total(2);
    expect([36 + 20, 36 + 20 * 2, som(sum)]).toEqual([56, 76, '1830000']);
  });
});

describe('B14 date window', () => {
  it('Tashkent 2026-10-25 = [2026-10-24T19:00Z, 2026-10-25T19:00Z)', () => {
    expect(localStartUtc('2026-10-25').toISOString()).toBe('2026-10-24T19:00:00.000Z');
    expect(localStartUtc('2026-10-26').toISOString()).toBe('2026-10-25T19:00:00.000Z');
  });
});
