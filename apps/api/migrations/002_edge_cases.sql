-- v2: Notify me, statement dates, multi-file imports.

-- "Notify me": a holding we have no bond data for yet. Kept out of totals until terms arrive.
ALTER TABLE eh_holdings ADD COLUMN IF NOT EXISTS awaiting boolean NOT NULL DEFAULT false;
ALTER TABLE eh_holdings ADD COLUMN IF NOT EXISTS notify_requested_at timestamptz;
ALTER TABLE eh_holdings ADD COLUMN IF NOT EXISTS notified_at timestamptz;
CREATE INDEX IF NOT EXISTS eh_holdings_awaiting_idx ON eh_holdings (isin) WHERE awaiting;

-- Date printed on the statement the portfolio came from (to warn about older uploads).
ALTER TABLE eh_portfolios ADD COLUMN IF NOT EXISTS statement_date date;

-- Per-file results of a multi-file import, and the statement date found.
ALTER TABLE eh_imports ADD COLUMN IF NOT EXISTS files jsonb NOT NULL DEFAULT '[]';
ALTER TABLE eh_imports ADD COLUMN IF NOT EXISTS statement_date date;
-- Per-file hashes so the same file is caught even inside a multi-file upload.
ALTER TABLE eh_imports ADD COLUMN IF NOT EXISTS file_hashes text[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS eh_imports_hashes_idx ON eh_imports USING gin (file_hashes);
