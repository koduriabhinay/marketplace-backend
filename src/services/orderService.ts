import { randomUUID } from 'node:crypto';
import { PG, pgCode } from '../db/pool';
import { NotFoundError, UnprocessableError } from '../lib/errors';
import type { OrderRepository } from '../repositories/types';
import type { CreateOrderInput, ListOrdersQuery } from '../schemas/order';

export class OrderService {
  constructor(private readonly orders: OrderRepository) {}

  async place(input: CreateOrderInput) {
    try {
      return await this.orders.place(randomUUID(), input);
    } catch (err) {
      if (pgCode(err) === PG.FOREIGN_KEY_VIOLATION) {
        throw new UnprocessableError(`Customer ${input.customerId} does not exist`);
      }
      throw err;
    }
  }

  async get(id: string) {
    const order = await this.orders.findById(id);
    if (!order) throw new NotFoundError('Order', id);
    return order;
  }

  list(query: ListOrdersQuery) {
    return this.orders.list(query);
  }

  cancel(id: string) {
    return this.orders.cancel(id);
  }
}
