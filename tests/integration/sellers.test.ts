import { MISSING, asAdmin, asCustomer, asSeller, testClient } from '../helpers';

describe('Sellers API', () => {
  it('registering as a seller creates a public seller profile', async () => {
    const client = testClient();
    const seller = await asSeller(client, { name: '  Acme  ', email: 'Sales@Acme.COM' });

    const res = await client.get(`/api/v1/sellers/${seller.sellerId}`).expect(200);
    expect(res.body.data).toMatchObject({ name: 'Acme', email: 'sales@acme.com' });
  });

  it('only admins can create sellers directly', async () => {
    const client = testClient();
    const body = { name: 'Back Office Co', email: 'bo@example.com' };
    await client.post('/api/v1/sellers').send(body).expect(401);

    const seller = await asSeller(client);
    await client.post('/api/v1/sellers').set('Authorization', seller.auth).send(body).expect(403);

    const admin = await asAdmin(client);
    const res = await client.post('/api/v1/sellers').set('Authorization', admin.auth).send(body).expect(201);
    expect(res.headers.location).toBe(`/api/v1/sellers/${res.body.data.id}`);
    await client.post('/api/v1/sellers').set('Authorization', admin.auth).send(body).expect(409);
  });

  it('validates input and rejects unknown fields (mass assignment)', async () => {
    const client = testClient();
    const admin = await asAdmin(client);
    const res = await client
      .post('/api/v1/sellers')
      .set('Authorization', admin.auth)
      .send({ name: 'A', email: 'nope' })
      .expect(400);
    const paths = res.body.error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['name', 'email']));

    await client
      .post('/api/v1/sellers')
      .set('Authorization', admin.auth)
      .send({ name: 'Acme', email: 'a@example.com', isAdmin: true })
      .expect(400);
  });

  it('lists sellers publicly with pagination', async () => {
    const client = testClient();
    await asSeller(client);
    await asSeller(client);
    const res = await client.get('/api/v1/sellers?limit=1').expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.pagination).toEqual({ limit: 1, offset: 0, total: 2 });
  });

  it('a seller can update only their own profile; admins can update any', async () => {
    const client = testClient();
    const a = await asSeller(client);
    const b = await asSeller(client);
    const admin = await asAdmin(client);

    await client.patch(`/api/v1/sellers/${a.sellerId}`).send({ name: 'Nope' }).expect(401);
    await client.patch(`/api/v1/sellers/${b.sellerId}`).set('Authorization', a.auth).send({ name: 'Hijack' }).expect(403);

    const own = await client
      .patch(`/api/v1/sellers/${a.sellerId}`)
      .set('Authorization', a.auth)
      .send({ name: 'Renamed Shop' })
      .expect(200);
    expect(own.body.data.name).toBe('Renamed Shop');

    await client.patch(`/api/v1/sellers/${b.sellerId}`).set('Authorization', admin.auth).send({ name: 'Fixed' }).expect(200);
  });

  it('returns 409 when updating to an email another seller uses, 400 for empty updates', async () => {
    const client = testClient();
    const a = await asSeller(client);
    const b = await asSeller(client);
    await client.patch(`/api/v1/sellers/${a.sellerId}`).set('Authorization', a.auth).send({ email: b.email }).expect(409);
    await client.patch(`/api/v1/sellers/${a.sellerId}`).set('Authorization', a.auth).send({}).expect(400);
  });

  it('returns 404 for unknown sellers and 400 for malformed ids', async () => {
    const client = testClient();
    const admin = await asAdmin(client);
    await client.get(`/api/v1/sellers/${MISSING}`).expect(404);
    await client.get('/api/v1/sellers/not-a-uuid').expect(400);
    await client.patch(`/api/v1/sellers/${MISSING}`).set('Authorization', admin.auth).send({ name: 'Ghost Shop' }).expect(404);
  });

  it('customers cannot edit seller profiles', async () => {
    const client = testClient();
    const seller = await asSeller(client);
    const customer = await asCustomer(client);
    await client
      .patch(`/api/v1/sellers/${seller.sellerId}`)
      .set('Authorization', customer.auth)
      .send({ name: 'Hijack' })
      .expect(403);
  });
});
