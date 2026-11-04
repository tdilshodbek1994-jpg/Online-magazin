-- Landing & Target P1A: shop-paid ad spend that belongs to the shop (no partner) and can be tied to a landing,
-- split across flows (referral links) for reporting only. Never a wallet debit. Additive.
ALTER TABLE ad_expenses ALTER COLUMN partner_id DROP NOT NULL;
ALTER TABLE ad_expenses ADD COLUMN IF NOT EXISTS landing_id uuid REFERENCES landing_pages(id);
ALTER TABLE ad_expenses ADD CONSTRAINT ad_expenses_owner_check CHECK (partner_id IS NOT NULL OR payer = 'shop');
-- Shop rows have no partner, so the old (partner_id, source, external_key) key cannot dedupe them: own key.
CREATE UNIQUE INDEX IF NOT EXISTS ad_expenses_shop_external ON ad_expenses (source, external_key) WHERE partner_id IS NULL AND external_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ad_expenses_landing ON ad_expenses (landing_id) WHERE landing_id IS NOT NULL;
-- the import grain is recorded so a campaign/adset total is never added on top of ad rows (LT-086)
ALTER TABLE ad_expenses ADD COLUMN IF NOT EXISTS report_level text CHECK (report_level IN ('ad','adset','campaign','account','manual'));
