-- Run in Superset (SQL Lab) against the SNAPE database.
-- Goal: find the bond master table and the cash-flow table, then fill in
-- apps/api/src/providers/snape.ts (SNAPE_SQL + mapRow).

-- 1. Which schemas/tables look like bond data?
SELECT table_schema, table_name
FROM information_schema.tables
WHERE table_type = 'BASE TABLE'
  AND (table_name ILIKE '%bond%' OR table_name ILIKE '%security%' OR table_name ILIKE '%instrument%'
       OR table_name ILIKE '%cash%flow%' OR table_name ILIKE '%coupon%' OR table_name ILIKE '%redemption%'
       OR table_name ILIKE '%rating%' OR table_name ILIKE '%isin%')
ORDER BY 1, 2;

-- 2. Columns of a candidate table (replace schema/table).
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'REPLACE_SCHEMA' AND table_name = 'REPLACE_TABLE'
ORDER BY ordinal_position;

-- 3. Look at a few rows for a well-known ISIN (replace with a real one you know).
-- SELECT * FROM REPLACE_SCHEMA.REPLACE_TABLE WHERE isin = 'INE...' LIMIT 5;

-- 4. Distinct frequency / day-count values, so mapFrequency()/mapDayCount() cover them all.
-- SELECT interest_frequency, count(*) FROM REPLACE_SCHEMA.REPLACE_TABLE GROUP BY 1 ORDER BY 2 DESC;
-- SELECT day_count_convention, count(*) FROM REPLACE_SCHEMA.REPLACE_TABLE GROUP BY 1 ORDER BY 2 DESC;
