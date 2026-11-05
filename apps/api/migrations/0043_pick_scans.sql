-- Warehouse pick check: each scan (barcode or SKU typed/scanned) is recorded. A wrong item stops packing until a
-- correct full set is scanned; orders packed without scanning stay possible (manual mode is visible in history).
CREATE TABLE pick_scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  order_line_id uuid REFERENCES order_lines(id),
  code text NOT NULL,
  result text NOT NULL CHECK (result IN ('match','wrong','extra')),
  actor_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pick_scans_order ON pick_scans (order_id, created_at);
