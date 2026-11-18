import { MISSING, asAdmin, asCustomer, asSeller, testClient } from '../helpers';

describe('Customers API', () => {
  it('a customer can read their own profile, but not someone else’s', async () => {
    const client = testClient();
    const me = await asCustomer(client, { email: 'Jamie@Example.com' });
    const other = await asCustomer(client);

    const res = await client.get(`/api/v1/customers/${me.customerId}`).set('Authorization', me.auth).expect(200);
    expect(res.body.data.email).toBe('jamie@example.com');

    // 404, not 403: don't confirm that another customer's id exists.
    await client.get(`/api/v1/customers/${other.customerId}`).set('Authorization', me.auth).expect(404);
    await client.get(`/api/v1/customers/${me.customerId}`).expect(401);
  });

  it('sellers cannot read customer profiles; admins can', async () => {
    const client = testClient();
    const customer = await asCustomer(client);
    const seller = await asSeller(client);
    const admin = await asAdmin(client);
    await client.get(`/api/v1/customers/${customer.customerId}`).set('Authorization', seller.auth).expect(404);
    await client.get(`/api/v1/customers/${customer.customerId}`).set('Authorization', admin.auth).expect(200);
    await client.get(`/api/v1/customers/${MISSING}`).set('Authorization', admin.auth).expect(404);
  });

  it('only admins create customers directly; duplicates are 409', async () => {
    const client = testClient();
    const admin = await asAdmin(client);
    const customer = await asCustomer(client);
    const body = { name: 'Walk-in Buyer', email: 'walkin@example.com' };

    await client.post('/api/v1/customers').set('Authorization', customer.auth).send(body).expect(403);
    await client.post('/api/v1/customers').set('Authorization', admin.auth).send(body).expect(201);
    await client
      .post('/api/v1/customers')
      .set('Authorization', admin.auth)
      .send({ ...body, email: 'WALKIN@example.com' })
      .expect(409);
    await client.post('/api/v1/customers').set('Authorization', admin.auth).send({ name: 'J', email: 'x' }).expect(400);
  });
});
