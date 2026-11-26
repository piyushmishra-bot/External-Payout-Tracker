-- Whose holdings is a portfolio? Statements in another PAN are allowed as "family"
-- after the user confirms they have permission. Only a masked PAN is stored.
ALTER TABLE eh_portfolios ADD COLUMN IF NOT EXISTS owner_type text NOT NULL DEFAULT 'self' CHECK (owner_type IN ('self','family'));
ALTER TABLE eh_portfolios ADD COLUMN IF NOT EXISTS owner_label text;       -- e.g. "Dad"
ALTER TABLE eh_portfolios ADD COLUMN IF NOT EXISTS owner_pan_masked text;  -- e.g. XXXXX5678K

-- Audit trail of the user's confirmation (DPDP: record of the basis for processing).
CREATE TABLE IF NOT EXISTS eh_ownership_confirmations (
  id            uuid PRIMARY KEY,
  user_id       text NOT NULL,
  portfolio_id  uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('self','family')),
  owner_label   text,
  pan_masked    text,
  holder_name   text,
  confirmed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS eh_ownership_user_idx ON eh_ownership_confirmations (user_id);
