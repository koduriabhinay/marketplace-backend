import { cartCount, cartReducer, cartSubtotal, loadCart, MAX_QUANTITY, type CartItem } from './cart';

const item = { listingId: 'a', title: 'Lamp', priceCents: 1000, imageUrl: null };

describe('cartReducer', () => {
  it('adds, merges lines and caps at available stock', () => {
    let cart = cartReducer([], { type: 'add', item, quantity: 2, stock: 3 });
    cart = cartReducer(cart, { type: 'add', item, quantity: 5, stock: 3 });
    expect(cart).toEqual([{ ...item, quantity: 3 }]);
    expect(cartCount(cart)).toBe(3);
    expect(cartSubtotal(cart)).toBe(3000);
  });

  it('sets quantities within limits and removes at zero', () => {
    let cart: CartItem[] = [{ ...item, quantity: 1 }];
    cart = cartReducer(cart, { type: 'setQuantity', listingId: 'a', quantity: 1000 });
    expect(cart[0]!.quantity).toBe(MAX_QUANTITY);
    cart = cartReducer(cart, { type: 'setQuantity', listingId: 'a', quantity: 0 });
    expect(cart).toEqual([]);
  });
});

describe('loadCart', () => {
  it('drops malformed entries from storage instead of crashing', () => {
    const raw = JSON.stringify([
      { ...item, quantity: 2 },
      { listingId: 'b', title: 'x', priceCents: 'free', quantity: 1, imageUrl: null },
      { ...item, listingId: 'c', quantity: -1 },
      null,
    ]);
    expect(loadCart(raw)).toEqual([{ ...item, quantity: 2 }]);
    expect(loadCart('{not json')).toEqual([]);
    expect(loadCart(null)).toEqual([]);
  });
});
