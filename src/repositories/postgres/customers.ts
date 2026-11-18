import type { Pool } from 'pg';
import type { Customer } from '../../schemas/customer';
import type { CustomerRepository } from '../types';
import { iso } from './sql';

interface Row {
  id: string;
  name: string;
  email: string;
  created_at: Date;
  updated_at: Date;
}

const COLS = 'id, name, email, created_at, updated_at';

const toCustomer = (r: Row): Customer => ({
  id: r.id,
  name: r.name,
  email: r.email,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
});

export class PgCustomerRepository implements CustomerRepository {
  constructor(private readonly pool: Pool) {}

  async create(c: Pick<Customer, 'id' | 'name' | 'email'>) {
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO customers (id, name, email) VALUES ($1, $2, $3) RETURNING ${COLS}`,
      [c.id, c.name, c.email],
    );
    return toCustomer(rows[0]!);
  }

  async findById(id: string) {
    const { rows } = await this.pool.query<Row>(`SELECT ${COLS} FROM customers WHERE id = $1`, [id]);
    return rows[0] ? toCustomer(rows[0]) : null;
  }
}
