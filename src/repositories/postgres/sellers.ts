import type { Pool } from 'pg';
import type { Pagination } from '../../schemas/common';
import type { Seller } from '../../schemas/seller';
import type { SellerRepository } from '../types';
import { buildSet, iso, page } from './sql';

interface Row {
  id: string;
  name: string;
  email: string;
  created_at: Date;
  updated_at: Date;
}

const COLS = 'id, name, email, created_at, updated_at';

const toSeller = (r: Row): Seller => ({
  id: r.id,
  name: r.name,
  email: r.email,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
});

export class PgSellerRepository implements SellerRepository {
  constructor(private readonly pool: Pool) {}

  async create(s: Pick<Seller, 'id' | 'name' | 'email'>) {
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO sellers (id, name, email) VALUES ($1, $2, $3) RETURNING ${COLS}`,
      [s.id, s.name, s.email],
    );
    return toSeller(rows[0]!);
  }

  async findById(id: string) {
    const { rows } = await this.pool.query<Row>(`SELECT ${COLS} FROM sellers WHERE id = $1`, [id]);
    return rows[0] ? toSeller(rows[0]) : null;
  }

  async findByEmail(email: string) {
    const { rows } = await this.pool.query<Row>(`SELECT ${COLS} FROM sellers WHERE email = $1`, [email]);
    return rows[0] ? toSeller(rows[0]) : null;
  }

  async list(p: Pagination) {
    const [data, count] = await Promise.all([
      this.pool.query<Row>(
        `SELECT ${COLS} FROM sellers ORDER BY created_at DESC, id LIMIT $1 OFFSET $2`,
        [p.limit, p.offset],
      ),
      this.pool.query<{ total: number }>('SELECT count(*)::int AS total FROM sellers'),
    ]);
    return page(data.rows.map(toSeller), count.rows[0]!.total, p);
  }

  async update(id: string, patch: Partial<Pick<Seller, 'name' | 'email'>>) {
    const { clause, values } = buildSet(patch, { name: 'name', email: 'email' }, 2);
    const { rows } = await this.pool.query<Row>(
      `UPDATE sellers SET ${clause} WHERE id = $1 RETURNING ${COLS}`,
      [id, ...values],
    );
    return rows[0] ? toSeller(rows[0]) : null;
  }
}
