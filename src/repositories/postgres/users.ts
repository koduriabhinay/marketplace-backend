import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../../db/pool';
import type { Role } from '../../auth/types';
import { iso } from './sql';

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  role: Role;
  sellerId: string | null;
  customerId: string | null;
  totpSecretEnc: string | null;
  totpEnabled: boolean;
  totpLastStep: number | null;
  createdAt: string;
}

interface Row {
  id: string;
  email: string;
  password_hash: string;
  role: Role;
  seller_id: string | null;
  customer_id: string | null;
  totp_secret_enc: string | null;
  totp_enabled: boolean;
  totp_last_step: string | null;
  created_at: Date;
}

const COLS =
  'id, email, password_hash, role, seller_id, customer_id, totp_secret_enc, totp_enabled, totp_last_step, created_at';

const toUser = (r: Row): UserRecord => ({
  id: r.id,
  email: r.email,
  passwordHash: r.password_hash,
  role: r.role,
  sellerId: r.seller_id,
  customerId: r.customer_id,
  totpSecretEnc: r.totp_secret_enc,
  totpEnabled: r.totp_enabled,
  totpLastStep: r.totp_last_step === null ? null : Number(r.totp_last_step),
  createdAt: iso(r.created_at)!,
});

export interface NewAccount {
  userId: string;
  profileId: string;
  name: string;
  email: string;
  passwordHash: string;
  role: Role;
}

export class PgUserRepository {
  constructor(private readonly pool: Pool) {}

  /** Creates the seller/customer profile and the login account together, or neither. */
  async registerWithProfile(a: NewAccount): Promise<UserRecord> {
    return withTransaction(this.pool, async (client) => {
      if (a.role !== 'admin') {
        const table = a.role === 'seller' ? 'sellers' : 'customers';
        await client.query(`INSERT INTO ${table} (id, name, email) VALUES ($1, $2, $3)`, [
          a.profileId,
          a.name,
          a.email,
        ]);
      }
      const { rows } = await client.query<Row>(
        `INSERT INTO users (id, email, password_hash, role, seller_id, customer_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLS}`,
        [
          a.userId,
          a.email,
          a.passwordHash,
          a.role,
          a.role === 'seller' ? a.profileId : null,
          a.role === 'customer' ? a.profileId : null,
        ],
      );
      return toUser(rows[0]!);
    });
  }

  async findByEmail(email: string) {
    const { rows } = await this.pool.query<Row>(`SELECT ${COLS} FROM users WHERE email = $1`, [email]);
    return rows[0] ? toUser(rows[0]) : null;
  }

  async findById(id: string, db: Pool | PoolClient = this.pool) {
    const { rows } = await db.query<Row>(`SELECT ${COLS} FROM users WHERE id = $1`, [id]);
    return rows[0] ? toUser(rows[0]) : null;
  }

  async setTotpSecret(id: string, secretEnc: string) {
    await this.pool.query(
      'UPDATE users SET totp_secret_enc = $2, totp_enabled = false, totp_last_step = NULL, updated_at = now() WHERE id = $1',
      [id, secretEnc],
    );
  }

  async setTotpEnabled(id: string, enabled: boolean) {
    await this.pool.query(
      `UPDATE users SET totp_enabled = $2,
              totp_secret_enc = CASE WHEN $2 THEN totp_secret_enc ELSE NULL END,
              updated_at = now()
        WHERE id = $1`,
      [id, enabled],
    );
  }

  /**
   * Records a used TOTP step atomically. Returns false if this step (or a later one) was
   * already used, which makes each 6-digit code single-use even under concurrent requests.
   */
  async consumeTotpStep(id: string, step: number): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE users SET totp_last_step = $2
        WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)`,
      [id, step],
    );
    return rowCount === 1;
  }
}
