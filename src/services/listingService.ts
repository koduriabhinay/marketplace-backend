import { randomUUID } from 'node:crypto';
import { NotFoundError, UnprocessableError } from '../lib/errors';
import type { ListingRepository, SellerRepository } from '../repositories/types';
import type { CreateListingInput, ListListingsQuery, UpdateListingInput } from '../schemas/listing';

export class ListingService {
  constructor(
    private readonly listings: ListingRepository,
    private readonly sellers: SellerRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(input: CreateListingInput) {
    // The body is valid, but it points at a seller that doesn't exist: 422, not 400 or 404.
    if (!(await this.sellers.findById(input.sellerId))) {
      throw new UnprocessableError(`Seller ${input.sellerId} does not exist`);
    }
    const ts = this.now().toISOString();
    return this.listings.create({
      id: randomUUID(),
      ...input,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
    });
  }

  async get(id: string) {
    const listing = await this.listings.findById(id);
    if (!listing) throw new NotFoundError('Listing', id);
    return listing;
  }

  list(query: ListListingsQuery) {
    return this.listings.list(query);
  }

  async update(id: string, input: UpdateListingInput) {
    const updated = await this.listings.update(id, { ...input, updatedAt: this.now().toISOString() });
    if (!updated) throw new NotFoundError('Listing', id);
    return updated;
  }

  /** Soft delete: the row is kept for order history and audits, but hidden from reads. */
  async remove(id: string) {
    const ts = this.now().toISOString();
    const deleted = await this.listings.update(id, { deletedAt: ts, updatedAt: ts });
    if (!deleted) throw new NotFoundError('Listing', id);
  }
}
