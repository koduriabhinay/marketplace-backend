import { randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError } from '../lib/errors';
import type { SellerRepository } from '../repositories/types';
import type { Pagination } from '../schemas/common';
import type { CreateSellerInput, UpdateSellerInput } from '../schemas/seller';

export class SellerService {
  constructor(
    private readonly sellers: SellerRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(input: CreateSellerInput) {
    if (await this.sellers.findByEmail(input.email)) {
      throw new ConflictError('A seller with this email already exists');
    }
    const ts = this.now().toISOString();
    return this.sellers.create({ id: randomUUID(), ...input, createdAt: ts, updatedAt: ts });
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
    await this.get(id);
    if (input.email) {
      const existing = await this.sellers.findByEmail(input.email);
      if (existing && existing.id !== id) {
        throw new ConflictError('A seller with this email already exists');
      }
    }
    const updated = await this.sellers.update(id, { ...input, updatedAt: this.now().toISOString() });
    if (!updated) throw new NotFoundError('Seller', id);
    return updated;
  }
}
