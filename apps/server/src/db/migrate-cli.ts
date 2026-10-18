import { loadConfig } from '../config.js';
import { createPool } from './pool.js';
import { migrate } from './migrate.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl, 2);
try {
  const version = await migrate(pool, (msg) => console.log(msg));
  console.log(`schema version: ${version}`);
} catch (err) {
  console.error('migration failed:', err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
