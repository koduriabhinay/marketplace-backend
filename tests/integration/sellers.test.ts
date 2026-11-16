import { createSeller, testClient } from '../helpers';

describe('Sellers API', () => {
  it('creates a seller with 201, a Location header and a normalized email', async () => {
    const client = testClient();
    const res = await client
      .post('/api/v1/sellers')
      .send({ name: '  Acme  ', email: 'Sales@Acme.COM' })
      .expect(201);

    expect(res.body.data).toMatchObject({ name: 'Acme', email: 'sales@acme.com' });
    expect(res.headers.location).toBe(`/api/v1/sellers/${res.body.data.id}`);
  });

  it('returns 409 for a duplicate email', async () => {
    const client = testClient();
    await createSeller(client, { email: 'dup@example.com' });
    const res = await client
      .post('/api/v1/sellers')
      .send({ name: 'Other', email: 'DUP@example.com' })
      .expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('returns 400 with field details for invalid input', async () => {
    const res = await testClient().post('/api/v1/sellers').send({ name: 'A', email: 'nope' }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const paths = res.body.error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['name', 'email']));
  });

  it('rejects unknown fields (mass-assignment protection)', async () => {
    await testClient()
      .post('/api/v1/sellers')
      .send({ name: 'Acme', email: 'a@example.com', id: 'hacked', isAdmin: true })
      .expect(400);
  });

  it('gets, lists and updates sellers', async () => {
    const client = testClient();
    const seller = await createSeller(client);
    await createSeller(client);

    await client.get(`/api/v1/sellers/${seller.id}`).expect(200);

    const list = await client.get('/api/v1/sellers?limit=1').expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.pagination).toEqual({ limit: 1, offset: 0, total: 2 });

    const updated = await client
      .patch(`/api/v1/sellers/${seller.id}`)
      .send({ name: 'Renamed Shop' })
      .expect(200);
    expect(updated.body.data.name).toBe('Renamed Shop');
  });

  it('returns 409 when updating to an email another seller uses', async () => {
    const client = testClient();
    const a = await createSeller(client);
    const b = await createSeller(client);
    await client.patch(`/api/v1/sellers/${a.id}`).send({ email: b.email }).expect(409);
    await client.patch(`/api/v1/sellers/${a.id}`).send({ email: a.email }).expect(200);
  });

  it('returns 400 for an empty update and 404 for a missing seller', async () => {
    const client = testClient();
    const seller = await createSeller(client);
    await client.patch(`/api/v1/sellers/${seller.id}`).send({}).expect(400);
    await client
      .patch('/api/v1/sellers/00000000-0000-4000-8000-000000000000')
      .send({ name: 'Nobody Home' })
      .expect(404);
  });

  it('returns 400 for a malformed id and 404 for an unknown one', async () => {
    const client = testClient();
    await client.get('/api/v1/sellers/not-a-uuid').expect(400);
    await client.get('/api/v1/sellers/00000000-0000-4000-8000-000000000000').expect(404);
  });
});
