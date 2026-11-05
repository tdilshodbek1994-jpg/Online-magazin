import { beforeAll, describe, expect, it } from 'vitest';
import { parseCsv } from '../src/modules/catalog/imports.js';
import { api, setupApp, staff, type Staff, type T } from './helpers.js';

let t: T;
let s: Staff;
beforeAll(async () => { t = await setupApp(); s = await staff(t); });

describe('CSV import from Excel (Uzbek locale)', () => {
  it('semicolon files keep decimal commas inside one cell', () => {
    expect(parseCsv('a;b\n"x, y";246 000,50\n')).toEqual([['a', 'b'], ['x, y', '246 000,50']]);
    expect(parseCsv('a,b\n1,2\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('accepts Uzbek column names, spaced prices and "so‘m" suffix', async () => {
    await t.db.query(`INSERT INTO categories (slug, name) VALUES ('xl-cat', '{"uz-Latn":"Excel"}') ON CONFLICT DO NOTHING`);
    const csv = 'SKU;Nomi;Toifa;Narx;Qoldiq\nXL-1;Choynak Excel;xl-cat;246 000;5\nXL-2;Piyola Excel;xl-cat;"12 500,50 so‘m";0\nXL-3;Yomon narx;xl-cat;abc;1\n';
    const pv = await api(t, 'POST', '/admin/imports/products/preview', { token: s.catalog.token, body: { csv } });
    expect(pv.status).toBe(200);
    expect(pv.json.valid_rows).toBe(2);
    expect(pv.json.rejected_rows).toBe(1);
    expect(pv.json.errors[0]).toMatchObject({ line: 4, field: 'price_som' });
    const c = await api(t, 'POST', `/admin/imports/${pv.json.batch_id}/commit`, { token: s.catalog.token });
    expect(c.status).toBe(200);
    const prices = (await t.db.query(`SELECT s.sku_code, o.price_minor::text FROM skus s JOIN offers o ON o.sku_id=s.id WHERE s.sku_code IN ('XL-1','XL-2') ORDER BY 1`)).rows;
    expect(prices).toEqual([{ sku_code: 'XL-1', price_minor: '24600000' }, { sku_code: 'XL-2', price_minor: '1250050' }]);
  });
});

describe('CSV import: variant conflicts are caught at preview', () => {
  it('a new SKU repeating an existing variant of the same product is rejected before commit', async () => {
    await t.db.query(`INSERT INTO categories (slug, name) VALUES ('xl-cat', '{"uz-Latn":"Excel"}') ON CONFLICT DO NOTHING`);
    const first = 'SKU;Nomi;Toifa;Narx;variant\nVR-QORA;Choynak Variant;xl-cat;100 000;rang=qora\n';
    const p1 = await api(t, 'POST', '/admin/imports/products/preview', { token: s.catalog.token, body: { csv: first } });
    await api(t, 'POST', `/admin/imports/${p1.json.batch_id}/commit`, { token: s.catalog.token });
    const second = 'SKU;Nomi;Toifa;Narx;variant\nVR-QORA-2;Choynak Variant;xl-cat;100 000;rang=qora\nVR-OQ;Choynak Variant;xl-cat;100 000;rang=oq\nVR-OQ-2;Choynak Variant;xl-cat;100 000;rang=oq\n';
    const p2 = await api(t, 'POST', '/admin/imports/products/preview', { token: s.catalog.token, body: { csv: second } });
    expect(p2.json.valid_rows).toBe(1);
    expect(p2.json.errors.map((e: any) => e.code).sort()).toEqual(['variant_duplicate_in_file', 'variant_exists']);
    const c = await api(t, 'POST', `/admin/imports/${p2.json.batch_id}/commit`, { token: s.catalog.token });
    expect(c.status).toBe(200);
  });
});
