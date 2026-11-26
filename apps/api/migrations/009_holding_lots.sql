-- The same bond bought on different dates is kept as separate rows (one per date of investment).
-- Rows with no date (older statement uploads) still allow only one per bond in a holding.
ALTER TABLE eh_holdings DROP CONSTRAINT IF EXISTS eh_holdings_portfolio_id_isin_key;
CREATE UNIQUE INDEX IF NOT EXISTS eh_holdings_lot_uq ON eh_holdings (portfolio_id, isin, (COALESCE(acquired_on, DATE '1900-01-01')));
