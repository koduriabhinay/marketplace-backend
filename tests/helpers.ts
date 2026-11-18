import request from 'supertest';
import { createApp, type AppDeps } from '../src/app';
import { AuthService } from '../src/services/authService';
import { testPool } from './db';

export function testClient(deps: Partial<AppDeps> = {}) {
  return request(createApp({ pool: testPool(), ...deps }));
}

export type Client = ReturnType<typeof testClient>;

export const PASSWORD = 'correct horse battery staple';
export const MISSING = '00000000-0000-4000-8000-000000000000';

let counter = 0;
export const uniqueEmail = (prefix: string) => `${prefix}-${Date.now()}-${++counter}@example.com`;

export interface Actor {
  userId: string;
  email: string;
  token: string;
  refreshToken: string;
  sellerId: string | null;
  customerId: string | null;
  /** Value for the Authorization header. */
  auth: string;
}

export async function register(
  client: Client,
  role: 'seller' | 'customer',
  overrides: Record<string, unknown> = {},
): Promise<Actor> {
  const email = (overrides.email as string) ?? uniqueEmail(role);
  const res = await client
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, name: role === 'seller' ? 'Acme Goods' : 'Jamie Buyer', role, ...overrides })
    .expect(201);
  const { user, accessToken, refreshToken } = res.body.data;
  return {
    userId: user.id,
    email: user.email,
    token: accessToken,
    refreshToken,
    sellerId: user.sellerId,
    customerId: user.customerId,
    auth: `Bearer ${accessToken}`,
  };
}

export const asSeller = (client: Client, o?: Record<string, unknown>) => register(client, 'seller', o);
export const asCustomer = (client: Client, o?: Record<string, unknown>) => register(client, 'customer', o);

export async function asAdmin(client: Client): Promise<Actor> {
  const email = uniqueEmail('admin');
  await new AuthService(testPool()).createAdmin(email, PASSWORD);
  const res = await client.post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200);
  return {
    userId: '',
    email,
    token: res.body.data.accessToken,
    refreshToken: res.body.data.refreshToken,
    sellerId: null,
    customerId: null,
    auth: `Bearer ${res.body.data.accessToken}`,
  };
}

export const validListing = () => ({
  title: 'Wireless Mouse',
  description: 'Ergonomic, 2.4 GHz',
  priceCents: 2499,
  stock: 10,
});

export async function createListing(client: Client, seller: Actor, overrides: Record<string, unknown> = {}) {
  const res = await client
    .post('/api/v1/listings')
    .set('Authorization', seller.auth)
    .send({ ...validListing(), ...overrides })
    .expect(201);
  return res.body.data as { id: string; sellerId: string; stock: number; priceCents: number; primaryImageUrl: string | null };
}
