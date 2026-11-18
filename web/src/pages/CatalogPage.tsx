import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { listingsApi } from '../api/endpoints';
import { ErrorAlert } from '../components/Alert';
import { ListingCard } from '../components/ListingCard';
import { Pager } from '../components/Pager';
import { Spinner } from '../components/Spinner';

export const PAGE_SIZE = 12;

export function CatalogPage() {
  const [params, setParams] = useSearchParams();
  const offset = Math.max(0, Number(params.get('offset')) || 0);

  const { data, error, isPending, isPlaceholderData } = useQuery({
    queryKey: ['listings', 'catalog', offset],
    queryFn: ({ signal }) => listingsApi.list({ status: 'active', limit: PAGE_SIZE, offset }, signal),
    placeholderData: keepPreviousData, // keep the old page on screen while the next loads
  });

  return (
    <section>
      <header className="masthead">
        <p className="eyebrow">
          The shop{data ? ` · ${data.pagination.total} ${data.pagination.total === 1 ? 'piece' : 'pieces'}` : ''}
        </p>
        <h1>
          Good things, <em>from the people</em> who make them.
        </h1>
        <p className="lede">Every listing comes straight from an independent seller. Stock is live, checkout is safe to retry.</p>
      </header>
      {isPending && <Spinner label="Loading products" />}
      <ErrorAlert error={error} />
      {data && data.data.length === 0 && (
        <div className="panel empty">
          <h2>No products yet</h2>
          <p>Sellers haven't listed anything. Sign up as a seller to add the first product.</p>
        </div>
      )}
      {data && data.data.length > 0 && (
        <>
          <div className={`grid ${isPlaceholderData ? 'is-stale' : ''}`}>
            {data.data.map((l, i) => (
              <ListingCard key={l.id} listing={l} index={offset + i + 1} />
            ))}
          </div>
          <Pager
            offset={offset}
            limit={PAGE_SIZE}
            total={data.pagination.total}
            onChange={(next) => {
              setParams(next ? { offset: String(next) } : {});
              window.scrollTo({ top: 0 });
            }}
          />
        </>
      )}
    </section>
  );
}
