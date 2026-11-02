-- M22 stock & atomic reservation (MASTER 9.1), M23 warehouse foundation.

CREATE TABLE warehouses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  region_code text REFERENCES service_regions(code),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Physical buckets + logical reservation. reserved is part of on_hand_sellable (9.1).
CREATE TABLE stock_balances (
  sku_id uuid NOT NULL REFERENCES skus(id),
  merchant_org_id uuid NOT NULL REFERENCES organizations(id),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  on_hand_sellable int NOT NULL DEFAULT 0 CHECK (on_hand_sellable >= 0),
  reserved int NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  quarantine int NOT NULL DEFAULT 0 CHECK (quarantine >= 0),
  damaged int NOT NULL DEFAULT 0 CHECK (damaged >= 0),
  in_transit int NOT NULL DEFAULT 0 CHECK (in_transit >= 0),
  safety_buffer int NOT NULL DEFAULT 0 CHECK (safety_buffer >= 0),
  version int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sku_id, merchant_org_id, warehouse_id)
);

CREATE VIEW stock_atp AS
SELECT sku_id, merchant_org_id, warehouse_id, on_hand_sellable, reserved, safety_buffer,
       on_hand_sellable - reserved - safety_buffer AS raw_atp,
       GREATEST(0, on_hand_sellable - reserved - safety_buffer) AS atp
FROM stock_balances;

CREATE TABLE inventory_movements (
  id bigserial PRIMARY KEY,
  sku_id uuid NOT NULL,
  merchant_org_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('receipt','adjustment','dispatch','return_receipt','to_quarantine','from_quarantine','to_damaged','transfer_out','transfer_in')),
  bucket text NOT NULL CHECK (bucket IN ('on_hand_sellable','quarantine','damaged','in_transit')),
  qty_delta int NOT NULL CHECK (qty_delta <> 0),
  reason text,
  ref_type text NOT NULL,
  ref_id text NOT NULL,
  actor_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ref_type, ref_id, kind, bucket, sku_id, warehouse_id)
);
CREATE TRIGGER inventory_movements_immutable BEFORE UPDATE OR DELETE ON inventory_movements FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid,
  status text NOT NULL CHECK (status IN ('active_unpaid','allocated_for_fulfillment','consumed_on_dispatch','released','expired')),
  expires_at timestamptz,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'active_unpaid' OR expires_at IS NOT NULL)
);
CREATE INDEX reservations_expiring ON reservations (expires_at) WHERE status = 'active_unpaid';

CREATE TABLE reservation_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL REFERENCES reservations(id),
  order_line_id uuid,
  sku_id uuid NOT NULL,
  merchant_org_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  qty int NOT NULL CHECK (qty > 0),
  FOREIGN KEY (sku_id, merchant_org_id, warehouse_id) REFERENCES stock_balances(sku_id, merchant_org_id, warehouse_id)
);

CREATE TABLE shortage_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  order_id uuid,
  kind text NOT NULL CHECK (kind IN ('late_payment_no_stock','physical_deficit')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
