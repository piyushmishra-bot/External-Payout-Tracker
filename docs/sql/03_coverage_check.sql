-- Coverage: of the ISINs users actually hold, how many have complete terms in SNAPE?
-- Before launch: run against ISINs from BondScanner's own holdings (a proxy for what users hold elsewhere).
-- After launch: run against eh_holdings.
-- Replace table/column names to match SNAPE.

WITH held AS (
  SELECT DISTINCT isin FROM eh_holdings          -- or: BondScanner holdings table
),
terms AS (
  SELECT isin,
         (face_value IS NOT NULL AND coupon_rate IS NOT NULL AND interest_frequency IS NOT NULL
          AND maturity_date IS NOT NULL) AS complete,
         EXISTS (SELECT 1 FROM snape.bond_cashflows c WHERE c.isin = b.isin) AS has_cashflows
  FROM snape.bond_master b
)
SELECT count(*)                                        AS isins_held,
       count(t.isin)                                   AS found_in_snape,
       count(*) FILTER (WHERE t.complete)              AS complete_terms,
       count(*) FILTER (WHERE t.has_cashflows)         AS with_cashflows,
       round(100.0 * count(*) FILTER (WHERE t.complete) / NULLIF(count(*), 0), 1) AS pct_complete
FROM held h LEFT JOIN terms t USING (isin);

-- ISINs users entered by hand ("Your details") = gaps to raise with Deridata:
SELECT isin, count(*) AS holders
FROM eh_holdings WHERE custom_terms IS NOT NULL
GROUP BY 1 ORDER BY 2 DESC;
