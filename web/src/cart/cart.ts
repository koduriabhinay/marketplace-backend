/**
 * The cart lives in the browser (localStorage), not on the server: it costs nothing to
 * keep, survives a reload, and works logged out. Prices stored here are only for display;
 * the server prices every order from the database at checkout.
 */
export interface CartItem {
  listingId: string;
  title: string;
  priceCents: number;
  imageUrl: string | null;
  quantity: number;
}

export const MAX_QUANTITY = 100; // matches the API's per-line limit
export const MAX_LINES = 50;

export type CartAction =
  | { type: 'add'; item: Omit<CartItem, 'quantity'>; quantity: number; stock?: number }
  | { type: 'setQuantity'; listingId: string; quantity: number }
  | { type: 'remove'; listingId: string }
  | { type: 'clear' }
  | { type: 'replace'; items: CartItem[] };

export function cartReducer(items: CartItem[], action: CartAction): CartItem[] {
  switch (action.type) {
    case 'add': {
      const cap = Math.min(MAX_QUANTITY, action.stock ?? MAX_QUANTITY);
      const existing = items.find((i) => i.listingId === action.item.listingId);
      if (existing) {
        return items.map((i) =>
          i === existing ? { ...i, ...action.item, quantity: Math.min(cap, i.quantity + action.quantity) } : i,
        );
      }
      if (items.length >= MAX_LINES) return items;
      return [...items, { ...action.item, quantity: Math.max(1, Math.min(cap, action.quantity)) }];
    }
    case 'setQuantity':
      if (action.quantity <= 0) return items.filter((i) => i.listingId !== action.listingId);
      return items.map((i) =>
        i.listingId === action.listingId ? { ...i, quantity: Math.min(MAX_QUANTITY, Math.floor(action.quantity)) } : i,
      );
    case 'remove':
      return items.filter((i) => i.listingId !== action.listingId);
    case 'clear':
      return [];
    case 'replace':
      return action.items;
  }
}

export const STORAGE_KEY = 'mp.cart.v1';

/** Reads the saved cart, dropping anything malformed (it's user-editable storage). */
export function loadCart(raw: string | null): CartItem[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (i): i is CartItem =>
          typeof i === 'object' &&
          i !== null &&
          typeof i.listingId === 'string' &&
          typeof i.title === 'string' &&
          Number.isInteger(i.priceCents) &&
          Number.isInteger(i.quantity) &&
          i.quantity > 0 &&
          (i.imageUrl === null || typeof i.imageUrl === 'string'),
      )
      .slice(0, MAX_LINES)
      .map((i) => ({ ...i, quantity: Math.min(MAX_QUANTITY, i.quantity) }));
  } catch {
    return [];
  }
}

export const cartCount = (items: CartItem[]) => items.reduce((n, i) => n + i.quantity, 0);
export const cartSubtotal = (items: CartItem[]) => items.reduce((n, i) => n + i.priceCents * i.quantity, 0);
