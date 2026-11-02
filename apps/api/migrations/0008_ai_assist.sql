-- Stage F: limited, read-only AI assist (§24). Disabled by default.
INSERT INTO feature_flags (key, enabled, description) VALUES ('ai.enabled', false, 'AI assistants (shopping advisor, operator draft, description draft). Off until provider/data policy approved.') ON CONFLICT DO NOTHING;
CREATE TABLE ai_usage (
  day date NOT NULL,
  feature text NOT NULL,
  requests int NOT NULL DEFAULT 0,
  PRIMARY KEY (day, feature)
);
