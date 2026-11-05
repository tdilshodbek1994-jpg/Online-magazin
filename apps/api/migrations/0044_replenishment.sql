-- Replenishment (P1): suggestion → purchase draft → owner approval → ordered → partially received → received.
-- Stock grows only on actual receipt (inventory movement 'receipt'); an expected delivery never creates sellable stock.
CREATE TABLE suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  phone text,
  lead_days int CHECK (lead_days IS NULL OR lead_days BETWEEN 0 AND 365),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE SEQUENCE purchase_order_seq START 1001;
CREATE TABLE purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE DEFAULT ('PO-' || nextval('purchase_order_seq')),
  supplier_id uuid REFERENCES suppliers(id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','ordered','partially_received','received','cancelled')),
  note text,
  created_by uuid NOT NULL REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  ordered_at timestamptz,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE purchase_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  sku_id uuid NOT NULL REFERENCES skus(id),
  qty_ordered int NOT NULL CHECK (qty_ordered > 0),
  qty_received int NOT NULL DEFAULT 0 CHECK (qty_received >= 0 AND qty_received <= qty_ordered),
  unit_cost_minor bigint CHECK (unit_cost_minor IS NULL OR unit_cost_minor >= 0),
  UNIQUE (po_id, sku_id)
);
