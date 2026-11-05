-- Partner profile photo (shown on leaderboards) and public names on contest boards by owner decision.
ALTER TABLE partners ADD COLUMN avatar_key text;
ALTER TABLE cc_versions DROP CONSTRAINT IF EXISTS cc_versions_name_privacy_check;
ALTER TABLE cc_versions ADD CONSTRAINT cc_versions_name_privacy_check CHECK (name_privacy IN ('public','alias','consent'));
ALTER TABLE cc_versions ALTER COLUMN name_privacy SET DEFAULT 'public';
