-- Android app push notifications (Firebase Cloud Messaging). A device token belongs to the user who registered it
-- while logged in; logout or an «unregistered» answer from FCM revokes it. Deliveries are logged so a retried job
-- never pushes the same notification to the same device twice.
CREATE TABLE push_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  token text NOT NULL UNIQUE,
  platform text NOT NULL CHECK (platform IN ('android','ios')),
  app_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX push_devices_user ON push_devices (user_id) WHERE revoked_at IS NULL;

CREATE TABLE push_deliveries (
  notification_id uuid NOT NULL REFERENCES notifications(id),
  device_id uuid NOT NULL REFERENCES push_devices(id),
  sent_at timestamptz NOT NULL DEFAULT now(),
  provider_ref text,
  PRIMARY KEY (notification_id, device_id)
);
