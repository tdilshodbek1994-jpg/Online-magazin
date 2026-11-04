-- Operator Centre 3.0 — P1: three-audience messaging (spec §16). Internal notes stay in order_notes (never shown
-- outside). Messages meant for the customer or for the partner live here, each with an explicit audience and an
-- honest delivery state ("stored" = visible in their cabinet only; "queued" = handed to the notification outbox).
CREATE TABLE order_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  audience text NOT NULL CHECK (audience IN ('customer','partner')),
  body text NOT NULL CHECK (char_length(body) BETWEEN 2 AND 1000),
  author_id uuid NOT NULL REFERENCES users(id),
  channel text NOT NULL CHECK (channel IN ('cabinet','in_app','telegram')),
  delivery_state text NOT NULL DEFAULT 'stored' CHECK (delivery_state IN ('stored','queued','sent','failed','unknown')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_messages_order ON order_messages (order_id, created_at);
