-- Operator Centre 3.0 — P2: duplicate review (spec §18). A phone match is a signal, never proof: nothing is merged or
-- deleted automatically. An operator decides; a confirmed duplicate is cancelled with a canonical link, keeping both
-- order IDs and their full history. Paid/shipped orders go through refund/return flows instead (cancelOrder guards).
ALTER TABLE orders
  ADD COLUMN duplicate_of uuid REFERENCES orders(id),
  ADD COLUMN duplicate_review text CHECK (duplicate_review IN ('not_duplicate','duplicate')),
  ADD COLUMN duplicate_reviewed_by uuid REFERENCES users(id),
  ADD COLUMN duplicate_reviewed_at timestamptz;
