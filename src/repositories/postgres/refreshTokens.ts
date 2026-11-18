import type { Pool, PoolClient } from 'pg';

export interface RefreshTokenRecord {
  id: string;
  userId: string;
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

interface Row {
  id: string;
  user_id: string;
  family_id: string;
  expires_at: Date;
  revoked_at: Date | null;
}

const toRecord = (r: Row): RefreshTokenRecord => ({
  id: r.id,
  userId: r.user_id,
  familyId: r.family_id,
  expiresAt: r.expires_at,
  revokedAt: r.revoked_at,
});

export class PgRefreshTokenRepository {
  constructor(private readonly pool: Pool) {}

  async insert(
    t: { id: string; userId: string; familyId: string; tokenHash: string; expiresAt: Date },
    db: Pool | PoolClient = this.pool,
  ) {
    await db.query(
      `INSERT INTO refresh_tokens (id, user_id, family_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [t.id, t.userId, t.familyId, t.tokenHash, t.expiresAt],
    );
  }

  /** Locks the row so two simultaneous refreshes with the same token can't both rotate it. */
  async findByHashForUpdate(client: PoolClient, tokenHash: string) {
    const { rows } = await client.query<Row>(
      'SELECT id, user_id, family_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE',
      [tokenHash],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async markReplaced(client: PoolClient, id: string, replacedBy: string) {
    await client.query('UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1', [
      id,
      replacedBy,
    ]);
  }

  async revokeFamily(familyId: string, db: Pool | PoolClient = this.pool) {
    await db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [
      familyId,
    ]);
  }

  async revokeAllForUser(userId: string) {
    await this.pool.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [
      userId,
    ]);
  }
}
