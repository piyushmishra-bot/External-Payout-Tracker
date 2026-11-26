-- Run in Superset against the Horizon database (ISIN list).
SELECT table_schema, table_name
FROM information_schema.tables
WHERE table_name ILIKE '%isin%' OR table_name ILIKE '%instrument%' OR table_name ILIKE '%security%'
ORDER BY 1, 2;

-- Then: distinct instrument types, so horizon.ts normalise() maps them correctly.
-- SELECT instrument_type, count(*) FROM REPLACE_SCHEMA.REPLACE_TABLE GROUP BY 1 ORDER BY 2 DESC;
