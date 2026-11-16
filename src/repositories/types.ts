import type { Page, Pagination } from '../schemas/common';
import type { Listing, ListListingsQuery } from '../schemas/listing';
import type { Seller } from '../schemas/seller';

/**
 * Repositories hide WHERE data lives. Phase 1 uses memory; Phase 2 swaps in Postgres
 * without touching services or routes. Every method is async for that reason.
 */
export interface SellerRepository {
  create(seller: Seller): Promise<Seller>;
  findById(id: string): Promise<Seller | null>;
  findByEmail(email: string): Promise<Seller | null>;
  list(page: Pagination): Promise<Page<Seller>>;
  update(id: string, patch: Partial<Seller>): Promise<Seller | null>;
}

export interface ListingRepository {
  create(listing: Listing): Promise<Listing>;
  /** Returns null for missing AND soft-deleted listings. */
  findById(id: string): Promise<Listing | null>;
  list(query: ListListingsQuery): Promise<Page<Listing>>;
  update(id: string, patch: Partial<Listing>): Promise<Listing | null>;
}

export interface Repositories {
  sellers: SellerRepository;
  listings: ListingRepository;
}
