-- Partner cabinet v2: named streams ("oqim") and fast per-link statistics.
ALTER TABLE referral_links ADD COLUMN name text CHECK (name IS NULL OR char_length(name) <= 80);
CREATE INDEX referral_links_partner ON referral_links (partner_id, created_at DESC);
CREATE INDEX orders_attr_link ON orders ((attribution->>'link_id')) WHERE attributed_partner_id IS NOT NULL;
CREATE INDEX referral_touches_link ON referral_touches (link_id, touched_at) WHERE eligible;
