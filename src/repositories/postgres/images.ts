import type { Pool } from 'pg';
import { iso } from './sql';

export interface ListingImage {
  id: string;
  listingId: string;
  contentType: string;
  sizeBytes: number;
  storageKey: string;
  createdAt: string;
}

interface Row {
  id: string;
  listing_id: string;
  content_type: string;
  size_bytes: number;
  storage_key: string;
  created_at: Date;
}

const COLS = 'id, listing_id, content_type, size_bytes, storage_key, created_at';
const toImage = (r: Row): ListingImage => ({
  id: r.id,
  listingId: r.listing_id,
  contentType: r.content_type,
  sizeBytes: r.size_bytes,
  storageKey: r.storage_key,
  createdAt: iso(r.created_at)!,
});

export class PgImageRepository {
  constructor(private readonly pool: Pool) {}

  async create(img: Omit<ListingImage, 'createdAt'>) {
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO listing_images (id, listing_id, content_type, size_bytes, storage_key)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${COLS}`,
      [img.id, img.listingId, img.contentType, img.sizeBytes, img.storageKey],
    );
    return toImage(rows[0]!);
  }

  async listForListing(listingId: string) {
    const { rows } = await this.pool.query<Row>(
      `SELECT ${COLS} FROM listing_images WHERE listing_id = $1 ORDER BY created_at, id`,
      [listingId],
    );
    return rows.map(toImage);
  }

  async countForListing(listingId: string) {
    const { rows } = await this.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM listing_images WHERE listing_id = $1',
      [listingId],
    );
    return rows[0]!.n;
  }

  async find(listingId: string, id: string) {
    const { rows } = await this.pool.query<Row>(
      `SELECT ${COLS} FROM listing_images WHERE listing_id = $1 AND id = $2`,
      [listingId, id],
    );
    return rows[0] ? toImage(rows[0]) : null;
  }
}
