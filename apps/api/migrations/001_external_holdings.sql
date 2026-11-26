-- External Holdings schema. Postgres 14+.
-- All tables prefixed eh_ to keep them separate from core BondScanner tables.
-- user_id is the BondScanner user id (text so it works with uuid or numeric ids).

CREATE TABLE IF NOT EXISTS eh_schema_migrations (
  version     text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

-- Bond master cache: one row per ISIN, filled from SNAPE first, then Deridata.
CREATE TABLE IF NOT EXISTS eh_bond_master (
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
  record_date_offset     smallint,
  maturity_amount        numeric(18,2),
  redemptions            jsonb,           -- [{date, principal}] per unit
  cashflows              jsonb,           -- [{date, scheduledDate?, interest, principal, recordDate?}] per unit
  security_type          text,
  listed                 boolean,
  source                 text NOT NULL,   -- snape | deridata | horizon | fixture
  fetched_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS eh_bond_master_name_idx ON eh_bond_master (lower(name));
CREATE INDEX IF NOT EXISTS eh_bond_master_issuer_idx ON eh_bond_master (lower(issuer));

CREATE TABLE IF NOT EXISTS eh_market_holidays (
  holiday_date  date NOT NULL,
  calendar      text NOT NULL DEFAULT 'NSE_SETTLEMENT',
  description   text,
  PRIMARY KEY (holiday_date, calendar)
);

CREATE TABLE IF NOT EXISTS eh_consents (
  user_id      text NOT NULL,
  version      text NOT NULL,
  accepted_at  timestamptz NOT NULL DEFAULT now(),
  ip           text,
  user_agent   text,
  PRIMARY KEY (user_id, version)
);

CREATE TABLE IF NOT EXISTS eh_portfolios (
  id          uuid PRIMARY KEY,
  user_id     text NOT NULL,
  name        text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 40),
  source      text NOT NULL DEFAULT 'external' CHECK (source IN ('external')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX IF NOT EXISTS eh_portfolios_user_idx ON eh_portfolios (user_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS eh_portfolios_user_name_uq ON eh_portfolios (user_id, lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS eh_holdings (
  id               uuid PRIMARY KEY,
  portfolio_id     uuid NOT NULL REFERENCES eh_portfolios(id) ON DELETE CASCADE,
  isin             text NOT NULL,
  units            numeric(18,4) NOT NULL CHECK (units > 0),
  invested_amount  numeric(18,2),
  acquired_on      date,
  tracked_from     date NOT NULL,
  -- Terms the user typed for an ISIN we could not find. Payouts are shown as Unverified.
  custom_terms     jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (portfolio_id, isin)
);
CREATE INDEX IF NOT EXISTS eh_holdings_isin_idx ON eh_holdings (isin);

-- One row per upload or manual entry session. The uploaded file is never stored:
-- only its hash (to spot the same file twice) and the parsed rows until commit.
CREATE TABLE IF NOT EXISTS eh_imports (
  id                     uuid PRIMARY KEY,
  user_id                text NOT NULL,
  method                 text NOT NULL CHECK (method IN ('pdf','excel','csv','screenshot','manual')),
  status                 text NOT NULL DEFAULT 'parsed' CHECK (status IN ('parsed','committed','discarded','failed')),
  file_sha256            text,
  parser                 text,
  rows                   jsonb NOT NULL DEFAULT '[]',
  skipped                jsonb NOT NULL DEFAULT '[]',
  error                  text,
  committed_portfolio_id uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  committed_at           timestamptz
);
CREATE INDEX IF NOT EXISTS eh_imports_user_idx ON eh_imports (user_id, created_at DESC);

-- Payouts the user marked as received. Key = holding id + scheduled date.
-- holding_id is text: external holdings use their uuid, BondScanner holdings use 'bs:<isin>'.
CREATE TABLE IF NOT EXISTS eh_payout_receipts (
  user_id         text NOT NULL,
  holding_id      text NOT NULL,
  scheduled_date  date NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, holding_id, scheduled_date)
);
CREATE INDEX IF NOT EXISTS eh_payout_receipts_user_idx ON eh_payout_receipts (user_id);

CREATE TABLE IF NOT EXISTS eh_notification_prefs (
  user_id           text PRIMARY KEY,
  push              boolean NOT NULL DEFAULT true,
  email             boolean NOT NULL DEFAULT true,
  whatsapp          boolean NOT NULL DEFAULT false,
  day_before        boolean NOT NULL DEFAULT true,
  same_day          boolean NOT NULL DEFAULT true,
  confirm_nudge     boolean NOT NULL DEFAULT true,
  maturity_heads_up boolean NOT NULL DEFAULT true,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Transactional outbox. The reminder job inserts; a sender drains with SKIP LOCKED.
CREATE TABLE IF NOT EXISTS eh_notification_outbox (
  id               uuid PRIMARY KEY,
  user_id          text NOT NULL,
  idempotency_key  text NOT NULL UNIQUE,
  kind             text NOT NULL,
  channel          text NOT NULL CHECK (channel IN ('push','email','whatsapp')),
  title            text NOT NULL,
  body             text NOT NULL,
  link             text,
  payload          jsonb NOT NULL DEFAULT '{}',
  send_after       timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','skipped')),
  attempts         smallint NOT NULL DEFAULT 0,
  last_error       text,
  sent_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS eh_outbox_pending_idx ON eh_notification_outbox (send_after) WHERE status = 'pending';

-- Product analytics events (also forward to your analytics tool).
CREATE TABLE IF NOT EXISTS eh_events (
  id          bigserial PRIMARY KEY,
  user_id     text NOT NULL,
  name        text NOT NULL,
  props       jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS eh_events_name_idx ON eh_events (name, created_at);
