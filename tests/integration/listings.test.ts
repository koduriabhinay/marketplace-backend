import { MISSING, asAdmin, asCustomer, asSeller, createListing, testClient, validListing } from '../helpers';

describe('Listings API', () => {
  it('a seller creates a listing for themselves, with defaults applied', async () => {
    const client = testClient();
    const seller = await asSeller(client);
    const listing = await createListing(client, seller);
    expect(listing).toMatchObject({ sellerId: seller.sellerId, currency: 'USD', status: 'active', deletedAt: null });
  });

  it('requires login, and only sellers or admins can create listings', async () => {
    const client = testClient();
    const customer = await asCustomer(client);
    await client.post('/api/v1/listings').send(validListing()).expect(401);
    await client.post('/api/v1/listings').set('Authorization', customer.auth).send(validListing()).expect(403);
  });

  it('a seller cannot create a listing for another seller', async () => {
    const client = testClient();
    const a = await asSeller(client);
    const b = await asSeller(client);
    await client
      .post('/api/v1/listings')
      .set('Authorization', a.auth)
      .send({ ...validListing(), sellerId: b.sellerId })
      .expect(403);
  });

  it('admins must name the seller, and it must exist', async () => {
    const client = testClient();
    const admin = await asAdmin(client);
    const seller = await asSeller(client);
    await client.post('/api/v1/listings').set('Authorization', admin.auth).send(validListing()).expect(422);
    const missing = await client
      .post('/api/v1/listings')
      .set('Authorization', admin.auth)
      .send({ ...validListing(), sellerId: MISSING })
      .expect(422);
    expect(missing.body.error.code).toBe('UNPROCESSABLE_ENTITY');
    await client
      .post('/api/v1/listings')
      .set('Authorization', admin.auth)
      .send({ ...validListing(), sellerId: seller.sellerId })
      .expect(201);
  });

  it.each([
    ['negative stock', { stock: -1 }],
    ['fractional price', { priceCents: 19.99 }],
    ['zero price', { priceCents: 0 }],
    ['unsupported currency', { currency: 'EUR' }],
    ['short title', { title: 'ab' }],
    ['HTML in the title (XSS)', { title: '<script>alert(1)</script>' }],
  ])('returns 400 for %s', async (_label, override) => {
    const client = testClient();
    const seller = await asSeller(client);
    await client
      .post('/api/v1/listings')
      .set('Authorization', seller.auth)
      .send({ ...validListing(), ...override })
      .expect(400);
  });

  it('browsing is public: filter by seller and status, and paginate', async () => {
    const client = testClient();
    const a = await asSeller(client);
    const b = await asSeller(client);
    await createListing(client, a);
    await createListing(client, a, { status: 'inactive' });
    await createListing(client, b);

    const bySeller = await client.get(`/api/v1/listings?sellerId=${a.sellerId}`).expect(200);
    expect(bySeller.body.pagination.total).toBe(2);
    const active = await client.get(`/api/v1/listings?sellerId=${a.sellerId}&status=active`).expect(200);
    expect(active.body.pagination.total).toBe(1);
    await client.get('/api/v1/listings?limit=500').expect(400);
  });

  it('only the owning seller (or an admin) can update or delete a listing', async () => {
    const client = testClient();
    const owner = await asSeller(client);
    const other = await asSeller(client);
    const admin = await asAdmin(client);
    const listing = await createListing(client, owner);

    await client.patch(`/api/v1/listings/${listing.id}`).send({ stock: 1 }).expect(401);
    await client.patch(`/api/v1/listings/${listing.id}`).set('Authorization', other.auth).send({ stock: 1 }).expect(403);
    await client.delete(`/api/v1/listings/${listing.id}`).set('Authorization', other.auth).expect(403);

    const res = await client
      .patch(`/api/v1/listings/${listing.id}`)
      .set('Authorization', owner.auth)
      .send({ priceCents: 1999, stock: 4 })
      .expect(200);
    expect(res.body.data).toMatchObject({ priceCents: 1999, stock: 4 });
    await client.patch(`/api/v1/listings/${listing.id}`).set('Authorization', admin.auth).send({ stock: 2 }).expect(200);

    // The seller can never be changed on an existing listing.
    await client
      .patch(`/api/v1/listings/${listing.id}`)
      .set('Authorization', owner.auth)
      .send({ sellerId: other.sellerId })
      .expect(400);
  });

  it('soft-deletes with 204, then the listing is gone', async () => {
    const client = testClient();
    const seller = await asSeller(client);
    const listing = await createListing(client, seller);

    await client.delete(`/api/v1/listings/${listing.id}`).set('Authorization', seller.auth).expect(204);
    await client.get(`/api/v1/listings/${listing.id}`).expect(404);
    await client.delete(`/api/v1/listings/${listing.id}`).set('Authorization', seller.auth).expect(404);
    await client.patch(`/api/v1/listings/${listing.id}`).set('Authorization', seller.auth).send({ stock: 1 }).expect(404);
  });
});
