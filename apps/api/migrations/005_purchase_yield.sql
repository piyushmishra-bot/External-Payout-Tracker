-- Add manually now asks for ISIN, date of investment, units, invested amount and yield.
-- Yield at purchase (% a year) as the user entered it or as the statement shows it.
ALTER TABLE eh_holdings ADD COLUMN IF NOT EXISTS purchase_yield numeric(7,4);
