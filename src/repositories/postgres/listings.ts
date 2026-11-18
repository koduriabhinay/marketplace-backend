import type { Pool } from 'pg';
import type { Listing, ListListingsQuery } from '../../schemas/listing';
import type { ListingPatch, ListingRepository, NewListing } from '../types';
import { buildSet, buildWhere, iso, page } from './sql';

interface Row {
  id: string;
  seller_id: string;
  title: string;
  description: string;
  price_cents: number;
  currency: 'USD';
  stock: number;
  status: Listing['status'];
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  primary_image_id: string | null;
}

/**
 * The first image's ID comes along with every listing (one indexed lookup per row via
 * listing_images_listing_idx), so a catalog page shows thumbnails without an extra
 * request per card (the N+1 problem, moved to the browser).
 */
const COLS = `id, seller_id, title, description, price_cents, currency, stock, status, created_at, updated_at, deleted_at,
  (SELECT i.id FROM listing_images i WHERE i.listing_id = listings.id ORDER BY i.created_at, i.id LIMIT 1) AS primary_image_id`;

const toListing = (r: Row): Listing => ({
  id: r.id,
  sellerId: r.seller_id,
  title: r.title,
  description: r.description,
  priceCents: r.price_cents,
  currency: r.currency,
  stock: r.stock,
  status: r.status,
  primaryImageUrl: r.primary_image_id ? `/api/v1/listings/${r.id}/images/${r.primary_image_id}` : null,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
  deletedAt: iso(r.deleted_at),
});

const PATCH_COLUMNS: Record<keyof ListingPatch, string> = {
  title: 'title',
  description: 'description',
  priceCents: 'price_cents',
  currency: 'currency',
  stock: 'stock',
  status: 'status',
};

export class PgListingRepository implements ListingRepository {
  constructor(private readonly pool: Pool) {}

  async create(l: NewListing) {
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO listings (id, seller_id, title, description, price_cents, currency, stock, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLS}`,
      [l.id, l.sellerId, l.title, l.description, l.priceCents, l.currency, l.stock, l.status],
    );
    return toListing(rows[0]!);
  }

  async findById(id: string) {
    const { rows } = await this.pool.query<Row>(
      `SELECT ${COLS} FROM listings WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    return rows[0] ? toListing(rows[0]) : null;
  }

  async list(q: ListListingsQuery) {
    const { clause, values } = buildWhere(
      ['deleted_at IS NULL'],
      [
        ['seller_id', q.sellerId],
        ['status', q.status],
      ],
    );
    const limitParam = `$${values.length + 1}`;
    const offsetParam = `$${values.length + 2}`;
    const [data, count] = await Promise.all([
      this.pool.query<Row>(
        `SELECT ${COLS} FROM listings ${clause} ORDER BY created_at DESC, id LIMIT ${limitParam} OFFSET ${offsetParam}`,
        [...values, q.limit, q.offset],
      ),
      this.pool.query<{ total: number }>(`SELECT count(*)::int AS total FROM listings ${clause}`, values),
    ]);
    return page(data.rows.map(toListing), count.rows[0]!.total, q);
  }

  async update(id: string, patch: ListingPatch) {
    const { clause, values } = buildSet(patch, PATCH_COLUMNS, 2);
    const { rows } = await this.pool.query<Row>(
      `UPDATE listings SET ${clause} WHERE id = $1 AND deleted_at IS NULL RETURNING ${COLS}`,
      [id, ...values],
    );
    return rows[0] ? toListing(rows[0]) : null;
  }

  async softDelete(id: string) {
    const { rowCount } = await this.pool.query(
      'UPDATE listings SET deleted_at = now(), updated_at = now() WHERE id = $1 AND deleted_at IS NULL',
      [id],
    );
    return rowCount === 1;
  }
}
