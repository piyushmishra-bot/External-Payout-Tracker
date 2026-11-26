-- Bonds saved with only ISIN + quantity ("Details awaited") are looked up again on every
-- 6-hourly sync. If they are still missing after EH_ASK_DETAILS_AFTER_SYNCS tries, the user
-- gets one reminder that opens "Add details".
ALTER TABLE eh_holdings ADD COLUMN IF NOT EXISTS lookup_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE eh_holdings ADD COLUMN IF NOT EXISTS details_requested_at timestamptz;
