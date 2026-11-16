import type { Page, Pagination } from '../schemas/common';
import type { Listing, ListListingsQuery } from '../schemas/listing';
import type { Seller } from '../schemas/seller';
import type { ListingRepository, Repositories, SellerRepository } from './types';

/** Copies on the way in and out so callers can never mutate stored state by reference. */
const clone = <T>(v: T): T => structuredClone(v);

function paginate<T>(items: T[], { limit, offset }: Pagination): Page<T> {
  return {
    data: items.slice(offset, offset + limit).map(clone),
    pagination: { limit, offset, total: items.length },
  };
}

const byNewest = (a: { createdAt: string }, b: { createdAt: string }) =>
  b.createdAt.localeCompare(a.createdAt);

export class InMemorySellerRepository implements SellerRepository {
  private readonly rows = new Map<string, Seller>();

  async create(seller: Seller) {
    this.rows.set(seller.id, clone(seller));
    return clone(seller);
  }

  async findById(id: string) {
    const row = this.rows.get(id);
    return row ? clone(row) : null;
  }

  async findByEmail(email: string) {
    for (const row of this.rows.values()) if (row.email === email) return clone(row);
    return null;
  }

  async list(page: Pagination) {
    return paginate([...this.rows.values()].sort(byNewest), page);
  }

  async update(id: string, patch: Partial<Seller>) {
    const row = this.rows.get(id);
    if (!row) return null;
    const next = { ...row, ...patch, id };
    this.rows.set(id, next);
    return clone(next);
  }
}

export class InMemoryListingRepository implements ListingRepository {
  private readonly rows = new Map<string, Listing>();

  async create(listing: Listing) {
    this.rows.set(listing.id, clone(listing));
    return clone(listing);
  }

  async findById(id: string) {
    const row = this.rows.get(id);
    return row && !row.deletedAt ? clone(row) : null;
  }

  async list(query: ListListingsQuery) {
    const items = [...this.rows.values()]
      .filter((l) => !l.deletedAt)
      .filter((l) => !query.sellerId || l.sellerId === query.sellerId)
      .filter((l) => !query.status || l.status === query.status)
      .sort(byNewest);
    return paginate(items, query);
  }

  async update(id: string, patch: Partial<Listing>) {
    const row = this.rows.get(id);
    if (!row || row.deletedAt) return null;
    const next = { ...row, ...patch, id };
    this.rows.set(id, next);
    return clone(next);
  }
}

export function createInMemoryRepositories(): Repositories {
  return { sellers: new InMemorySellerRepository(), listings: new InMemoryListingRepository() };
}
