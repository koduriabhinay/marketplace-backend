import type { Pool } from 'pg';
import type { Repositories } from '../types';
import { PgCustomerRepository } from './customers';
import { PgListingRepository } from './listings';
import { PgOrderRepository } from './orders';
import { PgSellerRepository } from './sellers';

export function createPgRepositories(pool: Pool): Repositories {
  return {
    sellers: new PgSellerRepository(pool),
    customers: new PgCustomerRepository(pool),
    listings: new PgListingRepository(pool),
    orders: new PgOrderRepository(pool),
  };
}
