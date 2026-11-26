-- Who is using the tool: each browser's user id linked to the name and email the visitor gives on first use.
CREATE TABLE IF NOT EXISTS eh_users (
  user_id       text PRIMARY KEY,
  name          text NOT NULL,
  email         text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS eh_users_email_idx ON eh_users (lower(email));
CREATE INDEX IF NOT EXISTS eh_events_user_idx ON eh_events (user_id, created_at);

-- Supabase serves every table in the public schema through its REST API (anon key). Row level security with no
-- policies closes that door: only the app's own server connection (the table owner, which bypasses RLS) can read
-- or write. Harmless on other Postgres hosts.
ALTER TABLE eh_schema_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE eh_bond_master ENABLE ROW LEVEL SECURITY;
ALTER TABLE eh_bond_directory ENABLE ROW LEVEL SECURITY;
ALTER TABLE eh_market_holidays ENABLE ROW LEVEL SECURITY;
ALTER TABLE eh_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE eh_portfolios ENABLE ROW LEVEL SECURITY;
ALTER TABLE eh_holdings ENABLE ROW LEVEL SECURITY;
ALTER TABLE eh_payout_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE eh_notification_prefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE eh_notification_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE eh_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE eh_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE eh_ownership_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE eh_users ENABLE ROW LEVEL SECURITY;

-- Views for the Supabase dashboard (Table Editor → schema "eh_admin"). A separate schema, so they are not served
-- by the REST API. Times are shown in IST.
CREATE SCHEMA IF NOT EXISTS eh_admin;

-- One row per person: who they are, when they joined and last came back, what they have saved.
CREATE OR REPLACE VIEW eh_admin.users AS
SELECT
  u.name,
  u.email,
  (u.created_at + interval '5 hours 30 minutes') AS signed_up_ist,
  (u.last_seen_at + interval '5 hours 30 minutes') AS last_seen_ist,
  (SELECT count(DISTINCT h.isin) FROM eh_holdings h JOIN eh_portfolios p ON p.id = h.portfolio_id
    WHERE p.user_id = u.user_id AND p.deleted_at IS NULL) AS isins,
  (SELECT coalesce(sum(h.invested_amount), 0) FROM eh_holdings h JOIN eh_portfolios p ON p.id = h.portfolio_id
    WHERE p.user_id = u.user_id AND p.deleted_at IS NULL) AS total_invested,
  (SELECT count(*) FROM eh_events e WHERE e.user_id = u.user_id AND e.name LIKE 'eh_portfolio_%') AS uploads_saved,
  (SELECT count(*) FROM eh_events e WHERE e.user_id = u.user_id AND e.name = 'eh_visit') AS visits,
  u.user_id
FROM eh_users u
ORDER BY u.last_seen_at DESC;

-- Everything that happened, newest first, with the person's name and email.
CREATE OR REPLACE VIEW eh_admin.activity AS
SELECT
  (e.created_at + interval '5 hours 30 minutes') AS at_ist,
  u.name,
  u.email,
  e.name AS event,
  e.props,
  e.user_id
FROM eh_events e
LEFT JOIN eh_users u ON u.user_id = e.user_id
ORDER BY e.created_at DESC;

-- Per day (IST): people active, new sign-ups, uploads saved, all events.
CREATE OR REPLACE VIEW eh_admin.daily_usage AS
SELECT
  (e.created_at + interval '5 hours 30 minutes')::date AS day_ist,
  count(DISTINCT e.user_id) AS active_users,
  count(*) FILTER (WHERE e.name = 'eh_signed_up') AS sign_ups,
  count(*) FILTER (WHERE e.name LIKE 'eh_portfolio_%') AS uploads_saved,
  count(*) AS events
FROM eh_events e
GROUP BY 1
ORDER BY 1 DESC;
