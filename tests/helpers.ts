import request from 'supertest';
import { createApp, type AppDeps } from '../src/app';
import { testPool } from './db';

export function testClient(deps: Partial<AppDeps> = {}) {
  return request(createApp({ pool: testPool(), ...deps }));
}

type Client = ReturnType<typeof testClient>;

let counter = 0;
const uniqueEmail = (prefix: string) => `${prefix}-${Date.now()}-${++counter}@example.com`;

export async function createSeller(client: Client, overrides: Record<string, unknown> = {}) {
  const res = await client
    .post('/api/v1/sellers')
    .send({ name: 'Acme Goods', email: uniqueEmail('seller'), ...overrides })
    .expect(201);
  return res.body.data as { id: string; email: string };
}

export async function createCustomer(client: Client, overrides: Record<string, unknown> = {}) {
  const res = await client
    .post('/api/v1/customers')
    .send({ name: 'Jamie Buyer', email: uniqueEmail('customer'), ...overrides })
    .expect(201);
  return res.body.data as { id: string; email: string };
}

export const validListing = (sellerId: string) => ({
  sellerId,
  title: 'Wireless Mouse',
  description: 'Ergonomic, 2.4 GHz',
  priceCents: 2499,
  stock: 10,
});

export async function createListing(client: Client, sellerId: string, overrides: Record<string, unknown> = {}) {
  const res = await client
    .post('/api/v1/listings')
    .send({ ...validListing(sellerId), ...overrides })
    .expect(201);
  return res.body.data as { id: string; stock: number; priceCents: number };
}
