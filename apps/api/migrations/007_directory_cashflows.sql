-- Bond directory rows can carry the issuer's published payout schedule (per unit) and say where they came from:
-- 'directory' = uploaded CSV/Excel file, 'bondscanner' = synced from bondscanner.com's live bonds.
ALTER TABLE eh_bond_directory ADD COLUMN IF NOT EXISTS cashflows jsonb;          -- [{date, interest, principal}] per unit
ALTER TABLE eh_bond_directory ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'directory';
ALTER TABLE eh_bond_directory ADD COLUMN IF NOT EXISTS external_id text;        -- the source's own id (bondscanner deal id)
