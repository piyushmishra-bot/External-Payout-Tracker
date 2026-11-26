-- Bond directory uploaded as a CSV/Excel file (POST /v1/external-holdings/admin/bond-directory).
-- Used for testing before SNAPE/Deridata access, and for bonds those sources do not cover.
-- Same columns as eh_bond_master; it is the source of truth, eh_bond_master stays a cache.
CREATE TABLE IF NOT EXISTS eh_bond_directory (
  isin                   text PRIMARY KEY,
  name                   text NOT NULL,
  issuer                 text NOT NULL,
  face_value             numeric(18,2) NOT NULL,
  coupon_rate            numeric(9,4) NOT NULL,
  frequency              smallint NOT NULL CHECK (frequency IN (0,1,2,4,12)),
  coupon_type            text NOT NULL DEFAULT 'fixed',
  day_count              text NOT NULL DEFAULT 'ACT/ACT',
  issue_date             date,
  maturity_date          date NOT NULL,
  rating                 text,
  rating_agency          text,
  maturity_amount        numeric(18,2),
  security_type          text,
  note                   text,            -- the file's Source/remarks column, kept for reference
  file_name              text,
  uploaded_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS eh_bond_directory_name_idx ON eh_bond_directory (lower(name));
CREATE INDEX IF NOT EXISTS eh_bond_directory_issuer_idx ON eh_bond_directory (lower(issuer));
