import { env } from '../config/env';
import { createPool } from '../db/pool';
import { logger } from '../lib/logger';
import { passwordSchema } from '../schemas/auth';
import { AuthService } from '../services/authService';

/**
 * Creates an admin account. Admins can't self-register over HTTP, so the first one is
 * bootstrapped from the command line by someone who already has server access:
 *   ADMIN_EMAIL=ops@example.com ADMIN_PASSWORD='long passphrase here' npm run create-admin
 */
async function main() {
  const email = process.env.ADMIN_EMAIL;
  const password = passwordSchema.parse(process.env.ADMIN_PASSWORD);
  if (!email) throw new Error('ADMIN_EMAIL is required');

  const pool = createPool({ connectionString: env.DATABASE_URL, max: 1, statementTimeoutMs: 10_000 });
  try {
    const admin = await new AuthService(pool).createAdmin(email, password);
    logger.info({ id: admin.id, email: admin.email }, 'Admin created');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  logger.fatal({ err }, 'Could not create admin');
  process.exit(1);
});
