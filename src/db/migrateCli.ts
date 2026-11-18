import { env } from '../config/env';
import { logger } from '../lib/logger';
import { migrate } from './migrate';
import { createPool } from './pool';

async function main() {
  const pool = createPool({ connectionString: env.DATABASE_URL, max: 1, statementTimeoutMs: 0 });
  try {
    const ran = await migrate(pool, (m) => logger.info(m));
    logger.info({ count: ran.length }, ran.length ? 'Migrations applied' : 'Database is up to date');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  logger.fatal({ err }, 'Migration failed');
  process.exit(1);
});
