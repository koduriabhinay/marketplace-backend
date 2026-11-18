import { randomUUID } from 'node:crypto';
import { assertCanManageSeller, resolveSellerForCreate } from '../auth/policies';
import type { AuthUser } from '../auth/types';
import { PG, pgCode } from '../db/pool';
import { NotFoundError, UnprocessableError } from '../lib/errors';
import type { ListingRepository } from '../repositories/types';
import type { CreateListingInput, ListListingsQuery, UpdateListingInput } from '../schemas/listing';

export class ListingService {
  constructor(private readonly listings: ListingRepository) {}

  async create(user: AuthUser, input: CreateListingInput) {
    const sellerId = resolveSellerForCreate(user, input.sellerId);
    try {
      return await this.listings.create({ id: randomUUID(), ...input, sellerId });
    } catch (err) {
      // The foreign key on seller_id rejects unknown sellers. The body is well-formed but
      // refers to something that doesn't exist: 422, not 400 or 404.
      if (pgCode(err) === PG.FOREIGN_KEY_VIOLATION) {
        throw new UnprocessableError(`Seller ${sellerId} does not exist`);
      }
      throw err;
    }
  }

  async get(id: string) {
    const listing = await this.listings.findById(id);
    if (!listing) throw new NotFoundError('Listing', id);
    return listing;
  }

  /** Loads a listing and checks the caller owns it (or is an admin). */
  async getForManagement(user: AuthUser, id: string) {
    const listing = await this.get(id);
    assertCanManageSeller(user, listing.sellerId);
    return listing;
  }

  list(query: ListListingsQuery) {
    return this.listings.list(query);
  }

  async update(user: AuthUser, id: string, input: UpdateListingInput) {
    await this.getForManagement(user, id);
    const updated = await this.listings.update(id, input);
    if (!updated) throw new NotFoundError('Listing', id);
    return updated;
  }

  /** Soft delete: the row stays for order history and audits, but is hidden from reads. */
  async remove(user: AuthUser, id: string) {
    await this.getForManagement(user, id);
    if (!(await this.listings.softDelete(id))) throw new NotFoundError('Listing', id);
  }
}
