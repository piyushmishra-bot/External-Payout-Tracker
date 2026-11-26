import { createDb, migrate } from './db';

const db = await createDb();
const applied = await migrate(db);
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date');
await db.close();
