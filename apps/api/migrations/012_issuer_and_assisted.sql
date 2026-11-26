-- Issuer name as the user gives it (template column or Add manually). Shown when the bond is not in our data yet.
ALTER TABLE eh_holdings ADD COLUMN IF NOT EXISTS issuer_name text;

-- "Send us your holdings in any format": the file is kept until our team has added the holdings (status done).
CREATE TABLE IF NOT EXISTS eh_assisted_uploads (
  id          uuid PRIMARY KEY,
  user_id     text NOT NULL,
  file_name   text NOT NULL,
  mime        text NOT NULL,
  size        integer NOT NULL,
  data        bytea NOT NULL,
  note        text,
  status      text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'done')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  done_at     timestamptz
);
CREATE INDEX IF NOT EXISTS eh_assisted_user_idx ON eh_assisted_uploads (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS eh_assisted_status_idx ON eh_assisted_uploads (status, created_at);
ALTER TABLE eh_assisted_uploads ENABLE ROW LEVEL SECURITY;
