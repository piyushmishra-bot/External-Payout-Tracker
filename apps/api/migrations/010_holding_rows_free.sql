-- Uploads add rows to the holding as they are: the user may add the same bond again (even on the same date)
-- or replace it. Uniqueness is no longer enforced; saving logic decides what to replace.
DROP INDEX IF EXISTS eh_holdings_lot_uq;
CREATE INDEX IF NOT EXISTS eh_holdings_portfolio_isin_idx ON eh_holdings (portfolio_id, isin);
