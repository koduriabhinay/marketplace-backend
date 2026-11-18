import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import { listingsApi, ordersApi } from '../api/endpoints';
import type { Order } from '../api/types';
import { Alert, ErrorAlert } from '../components/Alert';
import { Pager } from '../components/Pager';
import { Spinner } from '../components/Spinner';
import { formatDate, formatMoney, shortId } from '../lib/format';

const PAGE = 10;

export function OrdersPage() {
  const [offset, setOffset] = useState(0);
  const placed = (useLocation().state as { placed?: string } | null)?.placed;
  const orders = useQuery({
    queryKey: ['orders', offset],
    queryFn: ({ signal }) => ordersApi.list({ limit: PAGE, offset }, signal),
    placeholderData: keepPreviousData,
    meta: { private: true },
  });

  // Orders store listing IDs and the price paid; titles come from the catalog.
  const listingIds = [...new Set(orders.data?.data.flatMap((o) => o.items.map((i) => i.listingId)) ?? [])];
  const titles = useQueries({
    queries: listingIds.map((id) => ({
      queryKey: ['listing', id],
      queryFn: ({ signal }: { signal: AbortSignal }) => listingsApi.get(id, signal),
      retry: false,
    })),
  });
  const titleOf = (id: string) => titles[listingIds.indexOf(id)]?.data?.title;

  return (
    <section>
      <h1>My orders</h1>
      {placed && <Alert kind="success">Thank you! Order {shortId(placed)} is placed.</Alert>}
      {orders.isPending && <Spinner label="Loading orders" />}
      <ErrorAlert error={orders.error} />
      {orders.data?.data.length === 0 && (
        <div className="panel empty">
          <p>
            No orders yet. <Link to="/">Start shopping</Link>.
          </p>
        </div>
      )}
      <ul className="orders">
        {orders.data?.data.map((o) => <OrderCard key={o.id} order={o} titleOf={titleOf} />)}
      </ul>
      {orders.data && (
        <Pager offset={offset} limit={PAGE} total={orders.data.pagination.total} onChange={setOffset} />
      )}
    </section>
  );
}

function OrderCard({ order, titleOf }: { order: Order; titleOf(id: string): string | undefined }) {
  const queryClient = useQueryClient();
  const cancel = useMutation({
    mutationFn: () => ordersApi.cancel(order.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      void queryClient.invalidateQueries({ queryKey: ['listing'] }); // stock went back up
    },
  });

  return (
    <li className="card order">
      <header className="order-head">
        <div>
          <strong>Order {shortId(order.id)}</strong>
          <span className="muted"> · {formatDate(order.createdAt)}</span>
        </div>
        <span className={`status status-${order.status}`}>{order.status === 'placed' ? 'Placed' : 'Cancelled'}</span>
      </header>
      <table className="order-items">
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col">Qty</th>
            <th scope="col">Price</th>
          </tr>
        </thead>
        <tbody>
          {order.items.map((i) => (
            <tr key={i.listingId}>
              <td>
                <Link to={`/listings/${i.listingId}`}>{titleOf(i.listingId) ?? `Item ${shortId(i.listingId)}`}</Link>
              </td>
              <td>{i.quantity}</td>
              <td>{formatMoney(i.unitPriceCents * i.quantity)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <footer className="order-foot">
        <span>
          Total <strong>{formatMoney(order.totalCents)}</strong>
        </span>
        {order.status === 'placed' && (
          <button
            type="button"
            className="button secondary"
            disabled={cancel.isPending}
            onClick={() => {
              if (window.confirm('Cancel this order? The items go back on sale.')) cancel.mutate();
            }}
          >
            {cancel.isPending ? 'Cancelling…' : 'Cancel order'}
          </button>
        )}
      </footer>
      <ErrorAlert error={cancel.error} />
    </li>
  );
}
