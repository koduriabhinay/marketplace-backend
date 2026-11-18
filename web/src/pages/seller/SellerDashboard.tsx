import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { listingsApi } from '../../api/endpoints';
import type { Listing } from '../../api/types';
import { useAuth } from '../../auth/AuthProvider';
import { ErrorAlert } from '../../components/Alert';
import { Pager } from '../../components/Pager';
import { ProductImage } from '../../components/ProductImage';
import { Spinner } from '../../components/Spinner';
import { formatMoney } from '../../lib/format';

const PAGE = 20;

export function SellerDashboard() {
  const { user } = useAuth();
  const sellerId = user!.sellerId!;
  const [offset, setOffset] = useState(0);
  const queryClient = useQueryClient();

  // Includes inactive listings: sellers see everything they own, shoppers only active ones.
  const listings = useQuery({
    queryKey: ['listings', 'seller', sellerId, offset],
    queryFn: ({ signal }) => listingsApi.list({ sellerId, limit: PAGE, offset }, signal),
    placeholderData: keepPreviousData,
  });

  const toggle = useMutation({
    mutationFn: (l: Listing) => listingsApi.update(l.id, { status: l.status === 'active' ? 'inactive' : 'active' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['listings'] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => listingsApi.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['listings'] }),
  });

  return (
    <section>
      <div className="page-head">
        <h1>Seller dashboard</h1>
        <div className="actions">
          <Link className="button secondary" to="/seller/webhooks">
            Webhooks
          </Link>
          <Link className="button" to="/seller/listings/new">
            New listing
          </Link>
        </div>
      </div>
      {listings.isPending && <Spinner label="Loading your listings" />}
      <ErrorAlert error={listings.error ?? toggle.error ?? remove.error} />
      {listings.data?.data.length === 0 && (
        <div className="panel empty">
          <h2>No listings yet</h2>
          <p>Create your first product. Add a photo and it shows up in the shop right away.</p>
          <Link className="button" to="/seller/listings/new">
            Create a listing
          </Link>
        </div>
      )}
      {!!listings.data?.data.length && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col">Price</th>
                <th scope="col">Stock</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {listings.data.data.map((l) => (
                <tr key={l.id}>
                  <td>
                    <div className="product-cell">
                      <ProductImage src={l.primaryImageUrl} alt={l.title} className="table-thumb" />
                      <Link to={`/seller/listings/${l.id}`}>{l.title}</Link>
                    </div>
                  </td>
                  <td>{formatMoney(l.priceCents)}</td>
                  <td className={l.stock === 0 ? 'field-error' : ''}>{l.stock}</td>
                  <td>
                    <span className={`status status-${l.status}`}>{l.status === 'active' ? 'On sale' : 'Hidden'}</span>
                  </td>
                  <td className="row-actions">
                    <Link to={`/seller/listings/${l.id}`}>Edit</Link>
                    <button type="button" className="link-button" disabled={toggle.isPending} onClick={() => toggle.mutate(l)}>
                      {l.status === 'active' ? 'Hide' : 'Put on sale'}
                    </button>
                    <button
                      type="button"
                      className="link-button danger"
                      disabled={remove.isPending}
                      onClick={() => {
                        if (window.confirm(`Delete "${l.title}"? Past orders keep their record.`)) remove.mutate(l.id);
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {listings.data && <Pager offset={offset} limit={PAGE} total={listings.data.pagination.total} onChange={setOffset} />}
    </section>
  );
}
