import { randomUUID } from 'node:crypto';
import { PG, pgCode } from '../db/pool';
import { ConflictError, NotFoundError } from '../lib/errors';
import type { CustomerRepository } from '../repositories/types';
import type { CreateCustomerInput } from '../schemas/customer';

export class CustomerService {
  constructor(private readonly customers: CustomerRepository) {}

  async create(input: CreateCustomerInput) {
    try {
      return await this.customers.create({ id: randomUUID(), ...input });
    } catch (err) {
      if (pgCode(err) === PG.UNIQUE_VIOLATION) {
        throw new ConflictError('A customer with this email already exists');
      }
      throw err;
    }
  }

  async get(id: string) {
    const customer = await this.customers.findById(id);
    if (!customer) throw new NotFoundError('Customer', id);
    return customer;
  }
}
