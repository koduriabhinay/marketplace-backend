import { readdir } from 'node:fs/promises';
import { MISSING, asAdmin, asCustomer, asSeller, createListing, testClient } from '../helpers';

// Smallest valid-looking headers for each format; content after the magic bytes is irrelevant here.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(64, 3)]);
const HTML = Buffer.from('<html><script>alert(document.cookie)</script></html>');

async function setup() {
  const client = testClient();
  const seller = await asSeller(client);
  const listing = await createListing(client, seller);
  const upload = (buf: Buffer, filename: string, auth = seller.auth, listingId = listing.id) =>
    client
      .post(`/api/v1/listings/${listingId}/images`)
      .set('Authorization', auth)
      .attach('image', buf, { filename, contentType: 'image/png' });
  return { client, seller, listing, upload };
}

describe('Listing image uploads', () => {
  it.each([
    ['PNG', PNG, 'image/png'],
    ['JPEG', JPEG, 'image/jpeg'],
    ['WebP', WEBP, 'image/webp'],
  ])('accepts a %s, stores it under a random name, and serves it with safe headers', async (_n, buf, type) => {
    const { client, listing, upload } = await setup();
    const res = await upload(buf, '../../etc/passwd.png').expect(201);

    expect(res.body.data).toMatchObject({ listingId: listing.id, contentType: type, sizeBytes: buf.length });
    expect(res.body.data.storageKey).toBeUndefined();
    const files = await readdir(process.env.UPLOAD_DIR!);
    expect(files).toContain(`${res.body.data.id}.${type.split('/')[1] === 'jpeg' ? 'jpg' : type.split('/')[1]}`);
    expect(files.some((f) => f.includes('passwd'))).toBe(false); // user filename never used

    const file = await client.get(res.body.data.url).expect(200);
    expect(file.headers['content-type']).toBe(type);
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.headers['content-security-policy']).toContain("default-src 'none'");
    expect(Buffer.compare(file.body, buf)).toBe(0);

    const list = await client.get(`/api/v1/listings/${listing.id}/images`).expect(200);
    expect(list.body.data).toHaveLength(1);
  });

  it('rejects files whose bytes are not an allowed image, whatever their name or declared type', async () => {
    const { upload } = await setup();
    const res = await upload(HTML, 'cute-cat.png').expect(422);
    expect(res.body.error.message).toMatch(/JPEG, PNG and WebP/);
  });

  it('rejects files over the size limit with 413', async () => {
    const { upload } = await setup();
    const huge = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]);
    const res = await upload(huge, 'big.png').expect(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('requires the file, the right field name, and only one file', async () => {
    const { client, seller, listing } = await setup();
    const url = `/api/v1/listings/${listing.id}/images`;
    await client.post(url).set('Authorization', seller.auth).field('note', 'hi').expect(400);
    await client.post(url).set('Authorization', seller.auth).attach('photo', PNG, 'a.png').expect(400);
    await client.post(url).set('Authorization', seller.auth).send({}).expect(422);
  });

  it('only the owning seller or an admin can upload', async () => {
    const { client, upload } = await setup();
    const otherSeller = await asSeller(client);
    const customer = await asCustomer(client);
    const admin = await asAdmin(client);

    await upload(PNG, 'a.png', otherSeller.auth).expect(403);
    await upload(PNG, 'a.png', customer.auth).expect(403);
    await upload(PNG, 'a.png', admin.auth).expect(201);
    await upload(PNG, 'a.png', '').expect(401);
  });

  it('caps the number of images per listing', async () => {
    const { upload } = await setup();
    for (let i = 0; i < 10; i++) await upload(PNG, `p${i}.png`).expect(201);
    await upload(PNG, 'one-too-many.png').expect(409);
  });

  it('404s for unknown listings and images', async () => {
    const { client, listing, upload } = await setup();
    await upload(PNG, 'a.png', undefined, MISSING).expect(404);
    await client.get(`/api/v1/listings/${MISSING}/images`).expect(404);
    await client.get(`/api/v1/listings/${listing.id}/images/${MISSING}`).expect(404);
    await client.get(`/api/v1/listings/${listing.id}/images/not-a-uuid`).expect(400);
  });
});
