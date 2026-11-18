import { Link } from 'react-router';
import type { Listing } from '../api/types';
import { formatMoney } from '../lib/format';
import { ProductImage } from './ProductImage';

export function ListingCard({ listing, index }: { listing: Listing; index: number }) {
  return (
    <article className="listing-card">
      <Link to={`/listings/${listing.id}`} className="listing-card-link">
        <div className="card-meta">
          <span className="catalogue-no">No. {String(index).padStart(2, '0')}</span>
          {listing.stock === 0 ? (
            <span className="ribbon ribbon-out">Sold out</span>
          ) : listing.stock <= 5 ? (
            <span className="ribbon">Only {listing.stock} left</span>
          ) : null}
        </div>
        <div className="listing-card-media">
          <ProductImage src={listing.primaryImageUrl} alt={listing.title} />
        </div>
        <div className="listing-card-body">
          <h2 className="listing-card-title">{listing.title}</h2>
          <p className="price-tag">{formatMoney(listing.priceCents)}</p>
        </div>
      </Link>
    </article>
  );
}
