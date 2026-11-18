import { createContext, useContext, useEffect, useMemo, useReducer, type Dispatch, type ReactNode } from 'react';
import { cartReducer, loadCart, STORAGE_KEY, type CartAction, type CartItem } from './cart';

interface CartContextValue {
  items: CartItem[];
  dispatch: Dispatch<CartAction>;
}

const CartContext = createContext<CartContextValue | null>(null);

function readStorage() {
  try {
    return loadCart(localStorage.getItem(STORAGE_KEY));
  } catch {
    return [];
  }
}

export function CartProvider({ children }: { children: ReactNode }) {
  const [items, dispatch] = useReducer(cartReducer, undefined, readStorage);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch {
      /* storage full or disabled: the cart still works for this visit */
    }
  }, [items]);

  // Keep several open tabs showing the same cart.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) dispatch({ type: 'replace', items: loadCart(e.newValue) });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const value = useMemo(() => ({ items, dispatch }), [items]);
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used inside <CartProvider>');
  return ctx;
}
