import { beforeAll, describe, expect, it } from 'vitest';
import { api, mkProduct, setupApp, type T } from './helpers.js';

let t: T;
beforeAll(async () => { t = await setupApp(); });

describe('Catalog: in-stock first, exact total, typo-tolerant search', () => {
  it('lists in-stock products before sold-out ones and returns the total count', async () => {
    const inStock = await mkProduct(t, { name: 'Zarqaldoq lampa 1', stock: [5] });
    const soldOut = await mkProduct(t, { name: 'Zarqaldoq lampa 2', stock: [0] });
    await t.db.query(`UPDATE products SET published_at = now() + interval '1 minute' WHERE id=$1`, [soldOut.productId]); // newest, yet sold out
    const r = await api(t, 'GET', '/products?q=zarqaldoq&limit=10');
    expect(r.status).toBe(200);
    expect(r.json.total).toBe(2);
    expect(r.json.fuzzy).toBe(false);
    expect(r.json.items.map((x: any) => x.id)).toEqual([inStock.productId, soldOut.productId]);
  });

  it('a one-letter typo still finds the product and says the results are approximate', async () => {
    const p = await mkProduct(t, { name: 'Shamchiroqcha Bulbul', stock: [3] });
    const exact = await api(t, 'GET', '/products?q=shamchiroqcha');
    expect(exact.json.items.map((x: any) => x.id)).toContain(p.productId);
    const typo = await api(t, 'GET', '/products?q=shamchiroqchi');
    expect(typo.status).toBe(200);
    expect(typo.json.fuzzy).toBe(true);
    expect(typo.json.items.map((x: any) => x.id)).toContain(p.productId);
    const nothing = await api(t, 'GET', '/products?q=qwxzjvbn');
    expect(nothing.json.items).toEqual([]);
    expect(nothing.json.fuzzy).toBe(false);
  });
});
