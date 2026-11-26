import { config } from './config';
import { createDb, createPgDb, migrate, type Db } from './db';
import { NoOcr, TesseractOcr, type OcrEngine } from './parsers/image';
import { DeridataBondProvider } from './providers/deridata';
import { FixtureBondProvider, FixtureInternalHoldings, FixtureUserProfile, StructuralIsinDirectory } from './providers/fixture';
import { HttpUserProfile } from './providers/kyc';
import { HorizonIsinDirectory } from './providers/horizon';
import { SnapeBondProvider } from './providers/snape';
import type { BondDataProvider, InternalHoldingsProvider, IsinDirectory, UserProfileProvider } from './providers/types';
import { BondService, CalendarService } from './services/bonds';
import { HoldingsService } from './services/holdings';
import { ImportService } from './services/imports';
import { DirectoryBondProvider, DirectoryService } from './services/directory';

export interface Container {
  db: Db;
  bonds: BondService;
  calendar: CalendarService;
  holdings: HoldingsService;
  imports: ImportService;
  directory: DirectoryService;
}

/**
 * Wires the app from environment variables. Tests pass overrides instead.
 * BOND_PROVIDERS controls the lookup chain, e.g. "snape,deridata" in production
 * and "fixture" in development.
 */
export async function buildContainer(over: Partial<{ db: Db; providers: BondDataProvider[]; directory: IsinDirectory; internal: InternalHoldingsProvider; ocr: OcrEngine; includeBondScanner: boolean; profile: UserProfileProvider; ownershipCheck: boolean }> = {}): Promise<Container> {
  const db = over.db ?? (await createDb());
  await migrate(db);

  let providers = over.providers;
  if (!providers) {
    providers = [];
    for (const name of config.bondProviders) {
      if (name === 'fixture') providers.push(new FixtureBondProvider());
      else if (name === 'directory') providers.push(new DirectoryBondProvider(db));
      else if (name === 'snape') {
        if (!config.snapeDatabaseUrl) throw new Error('BOND_PROVIDERS includes snape but SNAPE_DATABASE_URL is not set');
        providers.push(new SnapeBondProvider(await createPgDb(config.snapeDatabaseUrl)));
      } else if (name === 'deridata') {
        if (!config.deridataBaseUrl || !config.deridataApiKey) throw new Error('BOND_PROVIDERS includes deridata but DERIDATA_BASE_URL / DERIDATA_API_KEY are not set');
        providers.push(new DeridataBondProvider(config.deridataBaseUrl, config.deridataApiKey, config.deridataTimeoutMs));
      } else throw new Error(`Unknown bond provider "${name}"`);
    }
  }
  const directory =
    over.directory ?? (config.horizonDatabaseUrl ? new HorizonIsinDirectory(await createPgDb(config.horizonDatabaseUrl)) : new StructuralIsinDirectory());
  // TODO(BondScanner): replace with a provider that reads the user's BondScanner holdings (orders/holdings service).
  const internal = over.internal ?? new FixtureInternalHoldings();
  // KYC PAN from the user service (KYC_PAN_URL); without it, users are asked "Mine / A family member's".
  const profile = over.profile ?? (config.kycPanUrl ? new HttpUserProfile(config.kycPanUrl, config.kycToken) : new FixtureUserProfile());
  const ocr = over.ocr ?? (config.ocrEngine === 'tesseract' ? new TesseractOcr() : new NoOcr());

  const bonds = new BondService(db, providers, config.bondCacheTtlHours);
  const calendar = new CalendarService(db);
  const holdings = new HoldingsService(db, bonds, calendar, internal, over.includeBondScanner ?? config.includeBondScannerHoldings);
  const imports = new ImportService(db, bonds, directory, ocr, profile, over.ownershipCheck ?? config.ownershipCheck);
  return { db, bonds, calendar, holdings, imports, directory: new DirectoryService(db, bonds) };
}
