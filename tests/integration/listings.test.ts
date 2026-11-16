import { createSeller, testClient, validListing } from '../helpers';

describe('Listings API', () => {
  it('creates a listing with defaults applied', async () => {
    const client = testClient();
    const seller = await createSeller(client);
    const res = await client.post('/api/v1/listings').send(validListing(seller.id)).expect(201);
    expect(res.body.data).toMatchObject({ currency: 'USD', status: 'active', deletedAt: null });
  });

  it('returns 422 when the seller does not exist', async () => {
    const res = await testClient()
      .post('/api/v1/listings')
      .send(validListing('00000000-0000-4000-8000-000000000000'))
      .expect(422);
    expect(res.body.error.code).toBe('UNPROCESSABLE_ENTITY');
  });

  it.each([
    ['negative stock', { stock: -1 }],
    ['fractional price', { priceCents: 19.99 }],
    ['zero price', { priceCents: 0 }],
    ['unsupported currency', { currency: 'EUR' }],
    ['short title', { title: 'ab' }],
  ])('returns 400 for %s', async (_label, override) => {
    const client = testClient();
    const seller = await createSeller(client);
    await client
      .post('/api/v1/listings')
      .send({ ...validListing(seller.id), ...override })
      .expect(400);
  });

  it('filters by seller and status, and paginates', async () => {
    const client = testClient();
    const a = await createSeller(client);
    const b = await createSeller(client);
    await client.post('/api/v1/listings').send(validListing(a.id)).expect(201);
    await client.post('/api/v1/listings').send({ ...validListing(a.id), status: 'inactive' }).expect(201);
    await client.post('/api/v1/listings').send(validListing(b.id)).expect(201);

    const bySeller = await client.get(`/api/v1/listings?sellerId=${a.id}`).expect(200);
    expect(bySeller.body.pagination.total).toBe(2);

    const active = await client.get(`/api/v1/listings?sellerId=${a.id}&status=active`).expect(200);
    expect(active.body.pagination.total).toBe(1);

    await client.get('/api/v1/listings?limit=500').expect(400);
  });

  it('updates a listing but never lets the seller be changed', async () => {
    const client = testClient();
    const seller = await createSeller(client);
    const { body } = await client.post('/api/v1/listings').send(validListing(seller.id)).expect(201);

    const res = await client
      .patch(`/api/v1/listings/${body.data.id}`)
      .send({ priceCents: 1999, stock: 4 })
      .expect(200);
    expect(res.body.data).toMatchObject({ priceCents: 1999, stock: 4 });

    await client.patch(`/api/v1/listings/${body.data.id}`).send({ sellerId: seller.id }).expect(400);
  });

  it('soft-deletes with 204, then the listing is gone', async () => {
    const client = testClient();
    const seller = await createSeller(client);
    const { body } = await client.post('/api/v1/listings').send(validListing(seller.id)).expect(201);

    await client.delete(`/api/v1/listings/${body.data.id}`).expect(204);
    await client.get(`/api/v1/listings/${body.data.id}`).expect(404);
    await client.delete(`/api/v1/listings/${body.data.id}`).expect(404);
  });
});
