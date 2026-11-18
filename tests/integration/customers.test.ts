import { createCustomer, testClient } from '../helpers';

describe('Customers API', () => {
  it('creates and fetches a customer', async () => {
    const client = testClient();
    const res = await client
      .post('/api/v1/customers')
      .send({ name: 'Jamie', email: 'Jamie@Example.com' })
      .expect(201);
    expect(res.body.data.email).toBe('jamie@example.com');

    const got = await client.get(`/api/v1/customers/${res.body.data.id}`).expect(200);
    expect(got.body.data.id).toBe(res.body.data.id);
  });

  it('returns 409 for a duplicate email (enforced by the database)', async () => {
    const client = testClient();
    await createCustomer(client, { email: 'same@example.com' });
    await client.post('/api/v1/customers').send({ name: 'Other', email: 'SAME@example.com' }).expect(409);
  });

  it('returns 404 for an unknown customer and 400 for bad input', async () => {
    const client = testClient();
    await client.get('/api/v1/customers/00000000-0000-4000-8000-000000000000').expect(404);
    await client.post('/api/v1/customers').send({ name: 'J', email: 'x' }).expect(400);
  });
});
