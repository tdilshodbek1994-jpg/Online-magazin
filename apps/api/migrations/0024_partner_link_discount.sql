-- "Mijoz uchun chegirma": a partner may give part of their own commission to the customer on one stream (link).
-- The old link keeps the normal price; a discount link shows price − discount. The discount is paid from the
-- partner's commission (never from the shop), is capped by the commission at creation, and is frozen per order line
-- so the operator sees exactly what the customer was promised.
ALTER TABLE referral_links ADD COLUMN customer_discount_minor bigint NOT NULL DEFAULT 0 CHECK (customer_discount_minor >= 0);
ALTER TABLE checkout_quotes ADD COLUMN partner_discount_link_id uuid REFERENCES referral_links(id);
ALTER TABLE quote_lines ADD COLUMN partner_discount_minor bigint NOT NULL DEFAULT 0 CHECK (partner_discount_minor >= 0);
ALTER TABLE order_lines ADD COLUMN partner_discount_minor bigint NOT NULL DEFAULT 0 CHECK (partner_discount_minor >= 0);
