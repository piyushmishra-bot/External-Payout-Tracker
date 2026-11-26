-- External Holdings adoption dashboard (Superset charts). Source: eh_* tables.

-- Funnel by week: consent → parsed import → portfolio created
SELECT date_trunc('week', created_at) AS week,
       count(DISTINCT user_id) FILTER (WHERE name = 'eh_consent_given')     AS consented,
       count(DISTINCT user_id) FILTER (WHERE name = 'eh_import_parsed')     AS uploaded,
       count(DISTINCT user_id) FILTER (WHERE name = 'eh_portfolio_created') AS created
FROM eh_events GROUP BY 1 ORDER BY 1;

-- Import quality by method/parser: share of rows matched without user edits
SELECT props->>'method' AS method, props->>'parser' AS parser, count(*) AS imports,
       sum((props->>'rows')::int) AS rows, sum((props->>'matched')::int) AS matched,
       round(100.0 * sum((props->>'matched')::int) / NULLIF(sum((props->>'rows')::int), 0), 1) AS pct_matched
FROM eh_events WHERE name = 'eh_import_parsed' GROUP BY 1, 2 ORDER BY imports DESC;

-- Tracked external AUM (face value) — the headline number
SELECT count(DISTINCT p.user_id) AS users, count(*) AS holdings,
       round(sum(h.units * m.face_value) / 1e7, 2) AS tracked_face_value_cr
FROM eh_holdings h JOIN eh_portfolios p ON p.id = h.portfolio_id AND p.deleted_at IS NULL
LEFT JOIN eh_bond_master m ON m.isin = h.isin;

-- Reminder delivery health
SELECT date_trunc('day', created_at) AS day, kind, channel, status, count(*)
FROM eh_notification_outbox GROUP BY 1, 2, 3, 4 ORDER BY 1 DESC;

-- Cross-sell: maturity heads-up sent → user bought on BondScanner within 30 days
-- (join to BondScanner orders table; replace names)
-- SELECT count(*) FROM eh_notification_outbox o JOIN orders x ON x.user_id = o.user_id
--   AND x.created_at BETWEEN o.sent_at AND o.sent_at + interval '30 days'
--  WHERE o.kind = 'maturity_30d' AND o.status = 'sent';
