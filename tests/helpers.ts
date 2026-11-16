import request from 'supertest';
import { createApp, type AppDeps } from '../src/app';

export function testClient(deps: AppDeps = {}) {
  return request(createApp(deps));
}

export async function createSeller(
  client: ReturnType<typeof testClient>,
  overrides: Record<string, unknown> = {},
) {
  const res = await client
    .post('/api/v1/sellers')
    .send({ name: 'Acme Goods', email: `acme-${Math.random()}@example.com`, ...overrides })
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
