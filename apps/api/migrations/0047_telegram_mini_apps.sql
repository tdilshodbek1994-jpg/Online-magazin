-- Telegram Mini Apps (partner bot first; operator later). A Telegram user is tied to ONE UzShop account per app.
-- The link is created only by someone who already proved the account (logged-in session or one-time link token),
-- so opening the bot alone never gives access to anyone's cabinet.
CREATE TABLE tg_app_links (
  app text NOT NULL CHECK (app IN ('partner','operator')),
  tg_user_id bigint NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  tg_username text,
  linked_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  PRIMARY KEY (app, tg_user_id),
  UNIQUE (app, user_id)
);

-- One-time, 10-minute token: the website cabinet makes it, the mini app consumes it (t.me/<bot>?startapp=l_<token>).
CREATE TABLE tg_app_link_tokens (
  token_hash bytea PRIMARY KEY,
  app text NOT NULL CHECK (app IN ('partner','operator')),
  user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  tg_user_id bigint
);
CREATE INDEX tg_app_link_tokens_user ON tg_app_link_tokens (user_id, created_at DESC);
