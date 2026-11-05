-- Reels: short vertical product videos with likes. Files live under MEDIA_DIR/videos (content-hash names).
CREATE TABLE product_videos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id),
  storage_key text NOT NULL CHECK (storage_key ~ '^[a-f0-9]{64}\.mp4$'),
  poster_key text,
  mime text NOT NULL CHECK (mime IN ('video/mp4')),
  bytes int NOT NULL CHECK (bytes > 0),
  sha256 text NOT NULL,
  caption jsonb NOT NULL DEFAULT '{}'::jsonb,
  rights_source text NOT NULL,
  sort int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','rejected')),
  likes int NOT NULL DEFAULT 0 CHECK (likes >= 0),
  views int NOT NULL DEFAULT 0 CHECK (views >= 0),
  uploaded_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, sha256)
);
CREATE INDEX product_videos_feed ON product_videos (created_at DESC) WHERE status = 'approved';
CREATE TABLE video_likes (
  video_id uuid NOT NULL REFERENCES product_videos(id),
  visitor_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (video_id, visitor_hash)
);
