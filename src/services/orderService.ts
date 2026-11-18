import { randomUUID } from 'node:crypto';
import { assertCanSeeCustomerResource, isAdmin, resolveCustomerForOrder } from '../auth/policies';
import type { AuthUser } from '../auth/types';
import { PG, pgCode } from '../db/pool';
import { ForbiddenError, NotFoundError, UnprocessableError } from '../lib/errors';
import type { OrderRepository } from '../repositories/types';
import type { CreateOrderRequest, ListOrdersQuery } from '../schemas/order';

export class OrderService {
  constructor(private readonly orders: OrderRepository) {}

  async place(user: AuthUser, input: CreateOrderRequest) {
    const customerId = resolveCustomerForOrder(user, input.customerId);
    try {
      return await this.orders.place(randomUUID(), { ...input, customerId });
    } catch (err) {
      if (pgCode(err) === PG.FOREIGN_KEY_VIOLATION) {
        throw new UnprocessableError(`Customer ${customerId} does not exist`);
      }
      throw err;
    }
  }

  async get(user: AuthUser, id: string) {
    const order = await this.orders.findById(id);
    if (!order) throw new NotFoundError('Order', id);
    assertCanSeeCustomerResource(user, order.customerId, 'Order', id);
    return order;
  }

  /** Customers only ever see their own orders, whatever filter they send. */
  list(user: AuthUser, query: ListOrdersQuery) {
    if (isAdmin(user)) return this.orders.list(query);
    if (user.role !== 'customer' || !user.customerId) throw new ForbiddenError();
    return this.orders.list({ ...query, customerId: user.customerId });
  }

  async cancel(user: AuthUser, id: string) {
    await this.get(user, id);
    return this.orders.cancel(id);
  }
}
