import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ApiError, NetworkError } from '../api/client';
import { listingsApi, ordersApi } from '../api/endpoints';
import type { Listing } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { Alert, ErrorAlert } from '../components/Alert';
import { ProductImage } from '../components/ProductImage';
import { cartSubtotal, MAX_QUANTITY, type CartItem } from '../cart/cart';
import { useCart } from '../cart/CartProvider';
import { formatMoney } from '../lib/format';

/**
 * Whether a failed checkout might still have gone through on the server. Only then is it
 * correct to retry with the SAME Idempotency-Key: the server either replays the order it
 * already placed or places it now, never both.
 */
export const outcomeUnknown = (err: unknown) =>
  err instanceof NetworkError ||
  (err instanceof ApiError && (err.status >= 500 || err.status === 429 || err.code === 'IDEMPOTENCY_IN_PROGRESS'));

export function CartPage() {
  const { items, dispatch } = useCart();
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const attempt = useRef<{ key: string; signature: string } | null>(null);
  const [retrying, setRetrying] = useState(false);

  // Fresh price and stock for everything in the cart: the saved copy may be days old.
  const live = useQueries({
    queries: items.map((i) => ({
      queryKey: ['listing', i.listingId],
      queryFn: ({ signal }: { signal: AbortSignal }) => listingsApi.get(i.listingId, signal),
      retry: (n: number, err: unknown) => !(err instanceof ApiError && err.status === 404) && n < 2,
    })),
  });
  const liveById = new Map<string, Listing | 'gone'>();
  live.forEach((q, idx) => {
    const id = items[idx]?.listingId;
    if (!id) return;
    if (q.data) liveById.set(id, q.data);
    else if (q.error instanceof ApiError && q.error.status === 404) liveById.set(id, 'gone');
  });

  const lines = items.map((item) => {
    const l = liveById.get(item.listingId);
    const problem =
      l === 'gone'
        ? 'This product was removed.'
        : l && l.status !== 'active'
          ? 'Not for sale right now.'
          : l && l.stock < item.quantity
            ? l.stock === 0
              ? 'Sold out.'
              : `Only ${l.stock} left.`
            : null;
    const priceCents = l && l !== 'gone' ? l.priceCents : item.priceCents;
    return { item, priceCents, priceChanged: priceCents !== item.priceCents, problem };
  });
  const subtotal = cartSubtotal(lines.map((l) => ({ ...l.item, priceCents: l.priceCents })));
  const blocked = lines.some((l) => l.problem);
  const checking = live.some((q) => q.isPending);

  const checkout = useMutation({
    mutationFn: () => {
      const payload = items.map((i) => ({ listingId: i.listingId, quantity: i.quantity }));
      const signature = JSON.stringify(payload);
      // Same cart as the attempt that may have reached the server: reuse its key.
      if (attempt.current?.signature !== signature) attempt.current = { key: crypto.randomUUID(), signature };
      setRetrying(false);
      return ordersApi.place(payload, attempt.current.key);
    },
    onSuccess: (order) => {
      attempt.current = null;
      dispatch({ type: 'clear' });
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      void queryClient.invalidateQueries({ queryKey: ['listing'] });
      void queryClient.invalidateQueries({ queryKey: ['listings'] });
      navigate('/orders', { state: { placed: order.id } });
    },
    onError: (err) => {
      if (outcomeUnknown(err)) setRetrying(true);
      else attempt.current = null; // a definite answer: the next try is a new request
      void queryClient.invalidateQueries({ queryKey: ['listing'] });
    },
  });

  if (items.length === 0) {
    return (
      <section className="panel empty">
        <h1>Your cart is empty</h1>
        <p>
          <Link to="/">Browse the shop</Link> to find something you like.
        </p>
      </section>
    );
  }

  return (
    <section>
      <h1>Your cart</h1>
      <div className="cart-layout">
        <ul className="cart-lines">
          {lines.map(({ item, priceCents, priceChanged, problem }) => (
            <CartLine
              key={item.listingId}
              item={item}
              priceCents={priceCents}
              priceChanged={priceChanged}
              problem={problem}
              onQuantity={(q) => dispatch({ type: 'setQuantity', listingId: item.listingId, quantity: q })}
              onRemove={() => dispatch({ type: 'remove', listingId: item.listingId })}
            />
          ))}
        </ul>
        <aside className="receipt" aria-label="Order summary">
          <h2>Summary</h2>
          <ul className="receipt-lines">
            {lines.map(({ item, priceCents }) => (
              <li key={item.listingId}>
                <span>
                  {item.quantity} × {item.title}
                </span>
                <span>{formatMoney(priceCents * item.quantity)}</span>
              </li>
            ))}
          </ul>
          <p className="summary-row">
            <span>Subtotal</span>
            <strong>{formatMoney(subtotal)}</strong>
          </p>
          <p className="muted small">The final price is confirmed when you place the order.</p>
          {!user ? (
            <Link className="button block" to="/login" state={{ from: '/cart' }}>
              Log in to check out
            </Link>
          ) : user.role !== 'customer' ? (
            <Alert kind="info">Log in with a customer account to place orders.</Alert>
          ) : (
            <button
              type="button"
              className="button block"
              disabled={checkout.isPending || blocked || checking}
              onClick={() => checkout.mutate()}
            >
              {checkout.isPending ? 'Placing order…' : retrying ? 'Try again' : 'Place order'}
            </button>
          )}
          {blocked && <p className="field-error">Fix the items marked above to check out.</p>}
          {checkout.error && (
            <>
              <ErrorAlert error={checkout.error} />
              {retrying && (
                <p className="muted small">
                  We couldn't confirm your order. Trying again is safe: you won't be charged twice.
                </p>
              )}
            </>
          )}
        </aside>
      </div>
    </section>
  );
}

interface LineProps {
  item: CartItem;
  priceCents: number;
  priceChanged: boolean;
  problem: string | null;
  onQuantity(q: number): void;
  onRemove(): void;
}

function CartLine({ item, priceCents, priceChanged, problem, onQuantity, onRemove }: LineProps) {
  return (
    <li className="card cart-line">
      <ProductImage src={item.imageUrl} alt={item.title} className="cart-thumb" />
      <div className="cart-line-info">
        <Link to={`/listings/${item.listingId}`}>{item.title}</Link>
        <p className="price">
          {formatMoney(priceCents)}
          {priceChanged && <span className="muted small"> (was {formatMoney(item.priceCents)})</span>}
        </p>
        {problem && <p className="field-error">{problem}</p>}
      </div>
      <label className="qty">
        <span className="visually-hidden">Quantity for {item.title}</span>
        <input
          type="number"
          min={1}
          max={MAX_QUANTITY}
          value={item.quantity}
          onChange={(e) => onQuantity(Number(e.target.value) || 1)}
        />
      </label>
      <button type="button" className="link-button danger" onClick={onRemove}>
        Remove
      </button>
    </li>
  );
}
