import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, migrate } from './db';

/**
 * Loads market holidays from data/holidays.csv (date,calendar,description).
 * Source: NSE equity segment holiday circular for 2026. Add 2027 when NSE publishes it (usually mid-December).
 * Confirm with the issuer/RTA team whether payout "working days" follow NSE or RBI/bank holidays;
 * if they differ, load the RBI list under calendar = 'NSE_SETTLEMENT' instead (it is the one the engine reads).
 */
const db = await createDb();
await migrate(db);
const csv = await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'holidays.csv'), 'utf8');
let n = 0;
for (const line of csv.split(/\r?\n/).slice(1)) {
  const [date, calendar, ...desc] = line.split(',');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) continue;
  await db.query(
    `INSERT INTO eh_market_holidays (holiday_date, calendar, description) VALUES ($1,$2,$3)
     ON CONFLICT (holiday_date, calendar) DO UPDATE SET description = EXCLUDED.description`,
    [date, calendar, desc.join(',')],
  );
  n++;
}
console.log(`Loaded ${n} holidays`);
await db.close();
