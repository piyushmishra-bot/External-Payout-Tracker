/** All configuration comes from environment variables. See .env.example. */
export const config = {
  port: Number(process.env.PORT ?? 4010),
  /** Real Postgres. If unset, an embedded PGlite database is used (dev and tests only). */
  databaseUrl: process.env.DATABASE_URL,

  /** Bond data sources, tried in this order after the local cache. */
  /** "directory" = the uploaded bond directory (eh_bond_directory). */
  bondProviders: (process.env.BOND_PROVIDERS ?? 'directory,fixture').split(',').map((s) => s.trim()).filter(Boolean),

  /** SNAPE: read-only copy of the Deridata bond directory. */
  snapeDatabaseUrl: process.env.SNAPE_DATABASE_URL,
  /** Horizon: ISIN list database. */
  horizonDatabaseUrl: process.env.HORIZON_DATABASE_URL,
  /** Deridata API, fallback for ISINs not in SNAPE. */
  deridataBaseUrl: process.env.DERIDATA_BASE_URL,
  deridataApiKey: process.env.DERIDATA_API_KEY,
  deridataTimeoutMs: Number(process.env.DERIDATA_TIMEOUT_MS ?? 8000),
  /** Internal KYC lookup, e.g. http://user-service/internal/users/{userId}/kyc → { "pan": "ABCDE1234F" }. */
  kycPanUrl: process.env.KYC_PAN_URL ?? '',
  kycToken: process.env.KYC_TOKEN ?? '',

  /** Re-fetch cached bond terms older than this (ratings change). */
  bondCacheTtlHours: Number(process.env.BOND_CACHE_TTL_HOURS ?? 6), // Deridata sync runs every 6 hours
  /** Include bonds bought on BondScanner in External Holdings totals. Off: External tab is external-only (Nov 2026 decision). */
  includeBondScannerHoldings: process.env.EH_INCLUDE_BONDSCANNER === 'true',
  /** Syncs (6-hourly) without data before we ask the user for a bond's details. 4 ≈ one day. */
  askDetailsAfterSyncs: Number(process.env.EH_ASK_DETAILS_AFTER_SYNCS ?? 4),
  /** v2: warn when a statement is in someone else's name (PAN check). Off in v1. */
  ownershipCheck: process.env.EH_OWNERSHIP_CHECK === 'true',
  /** Admin key for uploading the bond directory (header x-admin-token). Unset = upload is switched off. */
  adminToken: process.env.EH_ADMIN_TOKEN ?? '',
  /** bondscanner.com sources for the live-bond directory sync. */
  bondScannerApiUrl: process.env.BONDSCANNER_API_URL ?? 'https://loom.bondscanner.com',
  bondScannerSiteUrl: process.env.BONDSCANNER_SITE_URL ?? 'https://bondscanner.com',

  /** Auth: in production the gateway verifies the session and forwards the user id in this header. */
  userIdHeader: (process.env.USER_ID_HEADER ?? 'x-user-id').toLowerCase(),
  /** Set by BondScanner's gateway for a logged-in user; trusted only when GATEWAY_SECRET is set. */
  userNameHeader: (process.env.USER_NAME_HEADER ?? 'x-user-name').toLowerCase(),
  userEmailHeader: (process.env.USER_EMAIL_HEADER ?? 'x-user-email').toLowerCase(),
  /** Shared secret the gateway sends so the header cannot be spoofed from outside. */
  gatewaySecret: process.env.GATEWAY_SECRET,

  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB ?? 10) * 1024 * 1024,
  consentVersion: process.env.CONSENT_VERSION ?? '2026-11-v2',
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(','),

  /** OCR for screenshots: 'tesseract' (bundled, free) or 'none'. */
  ocrEngine: process.env.OCR_ENGINE ?? 'tesseract',

  /** Feature flag: comma separated user ids, or '*' for everyone. */
  rolloutUsers: process.env.EH_ROLLOUT_USERS ?? '*',
};

export function isEnabledFor(userId: string): boolean {
  const r = config.rolloutUsers.trim();
  if (r === '*') return true;
  return r.split(',').map((s) => s.trim()).includes(userId);
}
