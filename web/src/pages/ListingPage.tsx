import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { ApiError } from '../api/client';
import { listingsApi, sellersApi } from '../api/endpoints';
import { Alert, ErrorAlert } from '../components/Alert';
import { ProductImage } from '../components/ProductImage';
import { Spinner } from '../components/Spinner';
import { MAX_QUANTITY } from '../cart/cart';
import { useCart } from '../cart/CartProvider';
import { formatMoney } from '../lib/format';

export function ListingPage() {
  const { id = '' } = useParams();
  const { dispatch, items } = useCart();
  const [quantity, setQuantity] = useState(1);
  const [added, setAdded] = useState(false);
  const [selected, setSelected] = useState(0);

  const listing = useQuery({ queryKey: ['listing', id], queryFn: ({ signal }) => listingsApi.get(id, signal) });
  const images = useQuery({
    queryKey: ['listing', id, 'images'],
    queryFn: ({ signal }) => listingsApi.images(id, signal),
    enabled: listing.isSuccess,
  });
  const seller = useQuery({
    queryKey: ['seller', listing.data?.sellerId],
    queryFn: ({ signal }) => sellersApi.get(listing.data!.sellerId, signal),
    enabled: !!listing.data,
  });

  if (listing.isPending) return <Spinner label="Loading product" />;
  if (listing.error) {
    const missing = listing.error instanceof ApiError && listing.error.status === 404;
    return (
      <div className="panel">
        {missing ? (
          <>
            <h1>Product not found</h1>
            <p>It may have been removed by the seller.</p>
          </>
        ) : (
          <ErrorAlert error={listing.error} />
        )}
        <Link to="/">Back to the shop</Link>
      </div>
    );
  }

  const l = listing.data;
  const gallery = images.data ?? [];
  const main = gallery[selected]?.url ?? l.primaryImageUrl;
  const inCart = items.find((i) => i.listingId === l.id)?.quantity ?? 0;
  const available = l.status === 'active' && l.stock > 0;
  const maxQty = Math.max(0, Math.min(MAX_QUANTITY, l.stock) - inCart);

  function addToCart() {
    dispatch({
      type: 'add',
      item: { listingId: l.id, title: l.title, priceCents: l.priceCents, imageUrl: l.primaryImageUrl },
      quantity,
      stock: l.stock,
    });
    setAdded(true);
    setQuantity(1);
  }

  return (
    <article className="listing-detail">
      <div className="gallery">
        <ProductImage src={main} alt={l.title} className="gallery-main" />
        {gallery.length > 1 && (
          <div className="thumbs" role="list">
            {gallery.map((img, i) => (
              <button
                key={img.id}
                type="button"
                role="listitem"
                className={`thumb ${i === selected ? 'selected' : ''}`}
                onClick={() => setSelected(i)}
                aria-label={`Show photo ${i + 1}`}
              >
                <img src={img.url} alt="" />
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="detail-info">
        <nav className="crumbs" aria-label="Breadcrumb">
          <Link to="/">Shop</Link> <span aria-hidden="true">/</span> <span>{l.title}</span>
        </nav>
        <h1 className="detail-title">{l.title}</h1>
        {seller.data && <p className="byline">Sold by {seller.data.name}</p>}
        <p className="price-lg">{formatMoney(l.priceCents)}</p>
        {l.status !== 'active' ? (
          <Alert kind="info">This product is not for sale right now.</Alert>
        ) : l.stock === 0 ? (
          <Alert kind="info">Sold out.</Alert>
        ) : (
          <p className="stock">{l.stock <= 5 ? `Only ${l.stock} left in stock` : 'In stock'}</p>
        )}
        {available && (
          <div className="buy-box">
            <div className="stepper">
              <label htmlFor="qty">Quantity</label>
              <div className="stepper-controls">
                <button type="button" aria-label="One fewer" disabled={quantity <= 1} onClick={() => setQuantity(quantity - 1)}>
                  −
                </button>
                <input
                  id="qty"
                  type="number"
                  min={1}
                  max={Math.max(1, maxQty)}
                  value={quantity}
                  onChange={(e) => setQuantity(Math.max(1, Math.min(maxQty || 1, Number(e.target.value) || 1)))}
                />
                <button type="button" aria-label="One more" disabled={quantity >= maxQty} onClick={() => setQuantity(quantity + 1)}>
                  +
                </button>
              </div>
            </div>
            <button type="button" className="button" onClick={addToCart} disabled={maxQty === 0}>
              {maxQty === 0 ? 'All available stock is in your cart' : 'Add to cart'}
            </button>
          </div>
        )}
        {added && (
          <Alert kind="success">
            Added to your cart. <Link to="/cart">Go to cart</Link>
          </Alert>
        )}
        {l.description && (
          <section className="description">
            <h2>About this product</h2>
            {/* Rendered as text: React escapes it, so seller-written HTML can't run here. */}
            <p>{l.description}</p>
          </section>
        )}
      </div>
    </article>
  );
}
