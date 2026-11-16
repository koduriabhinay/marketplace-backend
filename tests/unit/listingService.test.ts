import { NotFoundError, UnprocessableError } from '../../src/lib/errors';
import { createInMemoryRepositories } from '../../src/repositories/memory';
import { ListingService } from '../../src/services/listingService';
import { SellerService } from '../../src/services/sellerService';

const fixedNow = () => new Date('2026-01-01T00:00:00.000Z');

function setup() {
  const repos = createInMemoryRepositories();
  return {
    sellers: new SellerService(repos.sellers, fixedNow),
    listings: new ListingService(repos.listings, repos.sellers, fixedNow),
  };
}

const base = { title: 'Desk Lamp', description: '', priceCents: 1500, currency: 'USD' as const, stock: 3, status: 'active' as const };

describe('ListingService', () => {
  it('rejects a listing for a seller that does not exist', async () => {
    const { listings } = setup();
    await expect(
      listings.create({ ...base, sellerId: '00000000-0000-4000-8000-000000000000' }),
    ).rejects.toBeInstanceOf(UnprocessableError);
  });

  it('stamps timestamps and starts not deleted', async () => {
    const { sellers, listings } = setup();
    const seller = await sellers.create({ name: 'Shop', email: 'shop@example.com' });
    const listing = await listings.create({ ...base, sellerId: seller.id });
    expect(listing).toMatchObject({ createdAt: '2026-01-01T00:00:00.000Z', deletedAt: null });
  });

  it('soft-deletes: a removed listing is hidden from get, list and update', async () => {
    const { sellers, listings } = setup();
    const seller = await sellers.create({ name: 'Shop', email: 'shop@example.com' });
    const listing = await listings.create({ ...base, sellerId: seller.id });

    await listings.remove(listing.id);

    await expect(listings.get(listing.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(listings.update(listing.id, { stock: 1 })).rejects.toBeInstanceOf(NotFoundError);
    await expect(listings.remove(listing.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listings.list({ limit: 20, offset: 0 })).pagination.total).toBe(0);
  });

  it('returns copies, so callers cannot mutate stored data', async () => {
    const { sellers, listings } = setup();
    const seller = await sellers.create({ name: 'Shop', email: 'shop@example.com' });
    const listing = await listings.create({ ...base, sellerId: seller.id });
    listing.stock = 999;
    expect((await listings.get(listing.id)).stock).toBe(3);
  });
});
