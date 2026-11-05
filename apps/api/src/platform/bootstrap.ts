import type { Queryable } from './db.js';

/**
 * Reference data needed by any environment: owner organization, main warehouse, a service region,
 * draft legal documents and DEMO policy fixtures (is_demo=true, status=draft — ignored in production, §02).
 * Idempotent.
 */
export async function bootstrapReference(q: Queryable, opts: { shopName?: string } = {}): Promise<void> {
  await q.query(`INSERT INTO organizations (kind, name, status) VALUES ('platform_owner', $1, 'active') ON CONFLICT DO NOTHING`, [opts.shopName ?? 'Online Magazin (DEMO)']);
  await q.query(`INSERT INTO service_regions (code, name) VALUES ('TAS', '{"uz-Latn":"Toshkent shahri","uz-Cyrl":"Тошкент шаҳри","ru":"г. Ташкент"}'), ('TO', '{"uz-Latn":"Toshkent viloyati","uz-Cyrl":"Тошкент вилояти","ru":"Ташкентская обл."}') ON CONFLICT DO NOTHING`);
  await q.query(`INSERT INTO warehouses (organization_id, code, name, region_code) SELECT id, 'MAIN', 'Asosiy ombor', 'TAS' FROM organizations WHERE kind='platform_owner' ON CONFLICT (code) DO NOTHING`);
  await q.query(`INSERT INTO legal_document_versions (doc_type, version, locale, title, body, effective_from)
     VALUES ('offer',1,'uz-Latn','Ommaviy oferta (QORALAMA)','DRAFT — huquqiy tekshiruvdan o''tmagan. Not legally reviewed.', now()),
            ('partner',1,'uz-Latn','Hamkorlik shartnomasi (QORALAMA)','DRAFT — huquqiy tekshiruvdan o''tmagan. Not legally reviewed.', now()),
            ('returns',1,'uz-Latn','Qaytarish shartlari (QORALAMA)','DRAFT — huquqiy tekshiruvdan o''tmagan.', now()),
            ('privacy',1,'uz-Latn','Maxfiylik siyosati (QORALAMA)','DRAFT — huquqiy tekshiruvdan o''tmagan.', now())
     ON CONFLICT DO NOTHING`);
  const demo: [string, unknown][] = [
    ['attribution.window_days', { days: 30 }],
    ['commission.hold_days', { days: 14 }],
    ['payout.min_minor', { amount_minor: '10000000' }],
    ['payout.approval_mode', { mode: 'two_person' }],
    ['partner_order.confirmation_ttl_hours', { hours: 24 }],
    ['legal.offer_version', { version: 'offer-v1-draft' }],
  ];
  for (const [key, value] of demo) {
    await q.query(`INSERT INTO business_policies (key, version, value, status, is_demo, source_note) VALUES ($1, 1, $2, 'draft', true, 'DEMO fixture from PHASE1_TASK §02/Appendix B — not an approved business value') ON CONFLICT DO NOTHING`, [key, JSON.stringify(value)]);
  }
  await q.query(`INSERT INTO delivery_zones (region_code, name, tariff_minor, eta_min_days, eta_max_days, cod_allowed)
     SELECT 'TAS', '{"uz-Latn":"Toshkent shahri (DEMO tarif)","uz-Cyrl":"Тошкент шаҳри (DEMO тариф)"}', 2000000, 1, 2, true
      WHERE NOT EXISTS (SELECT 1 FROM delivery_zones WHERE region_code='TAS' AND district IS NULL AND active)`);
  await q.query(`INSERT INTO search_synonyms (term, synonym) VALUES ('quloqchin','naushnik'), ('naushnik','quloqchin'), ('naushniki','quloqchin'), ('telefon','smartfon'), ('smartfon','telefon') ON CONFLICT DO NOTHING`);
}
