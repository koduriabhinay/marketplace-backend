import { randomUUID } from 'node:crypto';
import { assertCanManageSeller, resolveSellerForCreate } from '../auth/policies';
import type { AuthUser } from '../auth/types';
import type { ListingCache } from '../cache/listingCache';
import { PG, pgCode } from '../db/pool';
import type { ReplicaRouter } from '../db/replicaRouter';
import { NotFoundError, UnprocessableError } from '../lib/errors';
import type { ListingRepository } from '../repositories/types';
import type { CreateListingInput, ListListingsQuery, UpdateListingInput } from '../schemas/listing';

/** Optional read replica for the public catalog. */
export interface CatalogReplica {
  listings: ListingRepository;
  router: ReplicaRouter;
}

export class ListingService {
  constructor(
    private readonly listings: ListingRepository,
    private readonly cache?: ListingCache,
    private readonly replica?: CatalogReplica,
  ) {}

  async create(user: AuthUser, input: CreateListingInput) {
    const sellerId = resolveSellerForCreate(user, input.sellerId);
    try {
      const listing = await this.listings.create({ id: randomUUID(), ...input, sellerId });
      await this.changed([listing.id]); // new listing must appear in browse results
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

  /** Public read: cache first, then the read replica, then the primary. */
  async get(id: string) {
    const load = () => this.catalogRead(`listing:${id}`, (repo) => repo.findById(id));
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
    const load = () => this.catalogRead('listings:list', (repo) => repo.list(query));
    return this.cache ? this.cache.listListings(query, load) : load();
  }

  async update(user: AuthUser, id: string, input: UpdateListingInput) {
    await this.getForManagement(user, id);
    const updated = await this.listings.update(id, input);
    if (!updated) throw new NotFoundError('Listing', id);
    await this.changed([id]);
    return updated;
  }

  /** Soft delete: the row stays for order history and audits, but is hidden from reads. */
  async remove(user: AuthUser, id: string) {
    await this.getForManagement(user, id);
    if (!(await this.listings.softDelete(id))) throw new NotFoundError('Listing', id);
    await this.changed([id]);
  }

  /**
   * After any write to these listings (including stock changes from orders): mark them
   * recently written, so reads skip the lagging replica for a moment, then invalidate the
   * cache. Marking first means a read that misses the cache can't refill it from the replica.
   */
  async changed(ids: string[]) {
    await this.replica?.router.markWritten([...ids.map((id) => `listing:${id}`), 'listings:list']);
    await this.cache?.invalidate(ids);
  }

  private catalogRead<T>(key: string, read: (repo: ListingRepository) => Promise<T>): Promise<T> {
    if (!this.replica) return read(this.listings);
    return this.replica.router.read(
      key,
      () => read(this.replica!.listings),
      () => read(this.listings),
    );
  }
}
