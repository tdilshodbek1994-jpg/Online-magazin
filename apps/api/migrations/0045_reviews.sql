-- Product reviews (P1): only from a delivered order line of the same customer; moderated (spam/PII), with appeal by
-- reply. A low rating alone is never a reason to reject. No rewards for reviews.
CREATE TABLE product_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id),
  order_line_id uuid NOT NULL UNIQUE REFERENCES order_lines(id),
  user_id uuid NOT NULL REFERENCES users(id),
  rating int NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body text CHECK (body IS NULL OR length(body) <= 1000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','published','rejected')),
  reject_reason text CHECK (reject_reason IS NULL OR reject_reason IN ('spam','personal_data','offensive','not_about_product')),
  moderated_by uuid REFERENCES users(id),
  moderated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX product_reviews_product ON product_reviews (product_id, status, created_at DESC);
