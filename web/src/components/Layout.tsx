import { Link, NavLink, Outlet, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { cartCount } from '../cart/cart';
import { useCart } from '../cart/CartProvider';

export function Layout() {
  const { user, status, logout } = useAuth();
  const { items } = useCart();
  const navigate = useNavigate();
  const count = cartCount(items);

  async function onLogout() {
    await logout().catch(() => undefined); // the local session ends either way
    navigate('/');
  }

  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <div className="topline">
        <div className="container">Independent sellers · Live stock · Checkout that never charges twice</div>
      </div>
      <header className="site-header">
        <div className="container header-inner">
          <Link to="/" className="wordmark" aria-label="Marketplace home">
            market<em>place</em>
            <span className="wordmark-dot" aria-hidden="true" />
          </Link>
          <nav className="main-nav" aria-label="Main">
            <NavLink to="/" end>
              Shop
            </NavLink>
            {user?.role === 'customer' && <NavLink to="/orders">My orders</NavLink>}
            {user?.role === 'seller' && <NavLink to="/seller">Seller dashboard</NavLink>}
            <NavLink to="/cart" aria-label={`Cart, ${count} item${count === 1 ? '' : 's'}`}>
              Cart{count > 0 && <span className="badge">{count}</span>}
            </NavLink>
            {user ? (
              <>
                <NavLink to="/account">Account</NavLink>
                <button type="button" className="link-button" onClick={onLogout}>
                  Log out
                </button>
              </>
            ) : status === 'anonymous' ? (
              <>
                <NavLink to="/login">Log in</NavLink>
                <NavLink to="/register" className="button small">
                  Sign up
                </NavLink>
              </>
            ) : null}
          </nav>
        </div>
      </header>
      <main id="main" className="container">
        <Outlet />
      </main>
      <footer className="site-footer">
        <div className="container footer-inner">
          <p className="footer-mark">
            market<em>place</em>
          </p>
          <p className="muted small">
            A learning project. Prices in US dollars. Payments are not real: nothing is charged.
          </p>
        </div>
      </footer>
    </>
  );
}
