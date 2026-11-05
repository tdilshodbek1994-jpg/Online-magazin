-- Operator Centre load fixture (synthetic, disposable DB only): turns 1 000 of the historical load orders into orders
-- awaiting confirmation so the operator queue has 1 000 open tasks (spec §32 target). Run after prepare.sql.
\set ON_ERROR_STOP on
UPDATE orders SET commercial_status='awaiting_confirmation', confirmation_status='pending', payment_status='unpaid', fulfillment_status='unallocated',
       contact_snapshot='{"name":"Yuklama mijoz"}', address_snapshot='{"district":"Yunusobod","street":"Sinov","house":"1"}'
 WHERE id IN (SELECT id FROM orders WHERE guest_ref='hist' ORDER BY created_at DESC LIMIT 1000);
ANALYZE;
