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
      <header className="hero">
        <div className="hero-copy">
          <p className="eyebrow">The shop</p>
          <h1>
            Market day, <span className="hl">every day.</span>
          </h1>
          <p className="lede">
            Mugs, lamps, prints and other good things, straight from the independent sellers who make them.
          </p>
        </div>
        {data && (
          <div className="seal" aria-label={`${data.pagination.total} pieces in stock`}>
            <svg viewBox="0 0 200 200" aria-hidden="true">
              <defs>
                <path id="seal-circle" d="M100 100m-78 0a78 78 0 1 1 156 0a78 78 0 1 1-156 0" />
              </defs>
              <text>
                <textPath href="#seal-circle">FRESH STOCK ✦ INDEPENDENT SELLERS ✦ FRESH STOCK ✦ MADE BY PEOPLE ✦</textPath>
              </text>
            </svg>
            <span className="seal-count">{data.pagination.total}</span>
            <span className="seal-label">pieces</span>
          </div>
        )}
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
