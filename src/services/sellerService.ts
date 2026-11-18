import { randomUUID } from 'node:crypto';
import { PG, pgCode } from '../db/pool';
import { ConflictError, NotFoundError } from '../lib/errors';
import type { SellerRepository } from '../repositories/types';
import type { Pagination } from '../schemas/common';
import type { CreateSellerInput, UpdateSellerInput } from '../schemas/seller';

const duplicateEmail = () => new ConflictError('A seller with this email already exists');

export class SellerService {
  constructor(private readonly sellers: SellerRepository) {}

  /**
   * The unique index is the real guarantee. The pre-check only gives a friendly error in
   * the common case; two simultaneous signups both pass it, and the loser hits 23505.
   */
  async create(input: CreateSellerInput) {
    if (await this.sellers.findByEmail(input.email)) throw duplicateEmail();
    try {
      return await this.sellers.create({ id: randomUUID(), ...input });
    } catch (err) {
      if (pgCode(err) === PG.UNIQUE_VIOLATION) throw duplicateEmail();
      throw err;
    }
  }

  async get(id: string) {
    const seller = await this.sellers.findById(id);
    if (!seller) throw new NotFoundError('Seller', id);
    return seller;
  }

  list(page: Pagination) {
    return this.sellers.list(page);
  }

  async update(id: string, input: UpdateSellerInput) {
    try {
      const updated = await this.sellers.update(id, input);
      if (!updated) throw new NotFoundError('Seller', id);
      return updated;
    } catch (err) {
      if (pgCode(err) === PG.UNIQUE_VIOLATION) throw duplicateEmail();
      throw err;
    }
  }
}
