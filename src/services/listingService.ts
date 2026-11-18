import { randomUUID } from 'node:crypto';
import { assertCanManageSeller, resolveSellerForCreate } from '../auth/policies';
import type { AuthUser } from '../auth/types';
import type { ListingCache } from '../cache/listingCache';
import { PG, pgCode } from '../db/pool';
import { NotFoundError, UnprocessableError } from '../lib/errors';
import type { ListingRepository } from '../repositories/types';
import type { CreateListingInput, ListListingsQuery, UpdateListingInput } from '../schemas/listing';

export class ListingService {
  constructor(
    private readonly listings: ListingRepository,
    private readonly cache?: ListingCache,
  ) {}

  async create(user: AuthUser, input: CreateListingInput) {
    const sellerId = resolveSellerForCreate(user, input.sellerId);
    try {
      const listing = await this.listings.create({ id: randomUUID(), ...input, sellerId });
      await this.cache?.invalidate([]); // new listing must appear in browse results
      return listing;
    } catch (err) {
      // The foreign key on seller_id rejects unknown sellers. The body is well-formed but
      // refers to something that doesn't exist: 422, not 400 or 404.
      if (pgCode(err) === PG.FOREIGN_KEY_VIOLATION) {
        throw new UnprocessableError(`Seller ${sellerId} does not exist`);
      }
      throw err;
    }
  }

  /** Public read: served from the cache when possible. */
  async get(id: string) {
    const load = () => this.listings.findById(id);
    const listing = this.cache ? await this.cache.getListing(id, load) : await load();
    if (!listing) throw new NotFoundError('Listing', id);
    return listing;
  }

  /**
   * Loads a listing straight from the database and checks the caller owns it (or is an
   * admin). Permission checks never trust the cache.
   */
  async getForManagement(user: AuthUser, id: string) {
    const listing = await this.listings.findById(id);
    if (!listing) throw new NotFoundError('Listing', id);
    assertCanManageSeller(user, listing.sellerId);
    return listing;
  }

  list(query: ListListingsQuery) {
    const load = () => this.listings.list(query);
    return this.cache ? this.cache.listListings(query, load) : load();
  }

  async update(user: AuthUser, id: string, input: UpdateListingInput) {
    await this.getForManagement(user, id);
    const updated = await this.listings.update(id, input);
    if (!updated) throw new NotFoundError('Listing', id);
    await this.cache?.invalidate([id]);
    return updated;
  }

  /** Soft delete: the row stays for order history and audits, but is hidden from reads. */
  async remove(user: AuthUser, id: string) {
    await this.getForManagement(user, id);
    if (!(await this.listings.softDelete(id))) throw new NotFoundError('Listing', id);
    await this.cache?.invalidate([id]);
  }
}
