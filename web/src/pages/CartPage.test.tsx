import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { session } from '../api/client';
import { STORAGE_KEY } from '../cart/cart';
import { customer, json, listing, mockApi, renderApp, type Call } from '../test/utils';
import { CartPage } from './CartPage';

const L = listing();

function seedCart(quantity = 2) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify([{ listingId: L.id, title: L.title, priceCents: 4500, imageUrl: null, quantity }]),
  );
}

/** Logged-in customer: the page load swaps the session cookie for an access token. */
function loggedIn(extra: Record<string, (c: Call) => Response>) {
  localStorage.setItem('mp.session', '1');
  return mockApi({
    'POST /auth/refresh': () => json(200, { data: { accessToken: 'tok', tokenType: 'Bearer', expiresIn: 900 } }),
    'GET /auth/me': () => json(200, { data: customer }),
    [`GET /listings/${L.id}`]: () => json(200, { data: L }),
    ...extra,
  });
}

afterEach(() => session.clear());

describe('CartPage checkout', () => {
  it('shows live prices and asks logged-out shoppers to log in', async () => {
    seedCart();
    mockApi({ [`GET /listings/${L.id}`]: () => json(200, { data: L }) });
    renderApp(<CartPage />, { path: '/cart', route: '/cart' });
    expect(await screen.findByText('(was $45.00)')).toBeInTheDocument(); // price went up to $49
    expect(screen.getAllByText('$98.00').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Log in to check out' })).toBeInTheDocument();
  });

  it('blocks checkout when there is not enough stock', async () => {
    seedCart(5);
    mockApi({ [`GET /listings/${L.id}`]: () => json(200, { data: { ...L, stock: 3 } }) });
    renderApp(<CartPage />, { path: '/cart', route: '/cart' });
    expect(await screen.findByText('Only 3 left.')).toBeInTheDocument();
  });

  it('retries a failed checkout with the SAME Idempotency-Key, so it can never order twice', async () => {
    seedCart();
    let attempts = 0;
    const { calls } = loggedIn({
      'POST /orders': () => {
        attempts++;
        if (attempts === 1) throw new TypeError('Failed to fetch'); // the response got lost
        return json(201, { data: { id: 'order-123456789', items: [], totalCents: 9800 } });
      },
    });
    renderApp(<CartPage />, { path: '/cart', route: '/cart' });
    await userEvent.click(await screen.findByRole('button', { name: 'Place order' }));
    expect(await screen.findByText(/Trying again is safe/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Navigated away')).toBeInTheDocument();

    const posts = calls.filter((c) => c.method === 'POST' && c.path === '/orders');
    expect(posts).toHaveLength(2);
    const key = posts[0]!.headers['idempotency-key'];
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(posts[1]!.headers['idempotency-key']).toBe(key);
    expect(posts[0]!.body).toEqual({ items: [{ listingId: L.id, quantity: 2 }] });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual([]); // cart emptied
  });

  it('uses a NEW key after a definite answer (e.g. stock ran out)', async () => {
    seedCart();
    const { calls } = loggedIn({
      'POST /orders': () =>
        json(409, { error: { code: 'INSUFFICIENT_STOCK', message: 'Not enough stock for one or more items' } }),
    });
    renderApp(<CartPage />, { path: '/cart', route: '/cart' });
    await userEvent.click(await screen.findByRole('button', { name: 'Place order' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Not enough stock');
    await userEvent.click(screen.getByRole('button', { name: 'Place order' }));
    await screen.findByRole('alert');
    const keys = calls.filter((c) => c.path === '/orders').map((c) => c.headers['idempotency-key']);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });
});
