-- Owner decision (2026-11-05): customers distrust giving SMS codes (fraud fear). Partner-entered orders are confirmed by
-- the shop operator's own call instead. The SMS link/code step stays in code behind this flag (off by default).
INSERT INTO feature_flags (key, enabled, description) VALUES
  ('partner.customer_sms_confirm', false, 'Send the customer an SMS link + code to confirm partner-entered orders. Off: the operator calls the customer and confirms.')
ON CONFLICT (key) DO NOTHING;
