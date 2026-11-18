import { Link, NavLink, Outlet, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { cartCount } from '../cart/cart';
import { useCart } from '../cart/CartProvider';

export function Layout() {
  const { user, status, logout } = useAuth();
  const { items } = useCart();
  const navigate = useNavigate();
  const count = cartCount(items);
  // The dateline under a newspaper's masthead.
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  async function onLogout() {
    await logout().catch(() => undefined); // the local session ends either way
    navigate('/');
  }

  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className="site-header">
        <div className="container">
          <div className="dateline">
            <span>{today}</span>
            <span>Independent sellers · Prices in USD</span>
          </div>
          <Link to="/" className="wordmark" aria-label="Marketplace home">
            The Marketplace
          </Link>
          <nav className="main-nav" aria-label="Main">
            <div className="nav-group">
              <NavLink to="/" end>
                Shop
              </NavLink>
              {user?.role === 'customer' && <NavLink to="/orders">My orders</NavLink>}
              {user?.role === 'seller' && <NavLink to="/seller">Seller dashboard</NavLink>}
            </div>
            <div className="nav-group">
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
                  <NavLink to="/register">Sign up</NavLink>
                </>
              ) : null}
            </div>
          </nav>
        </div>
      </header>
      <main id="main" className="container">
        <Outlet />
      </main>
      <footer className="site-footer">
        <div className="container footer-inner">
          <p className="footer-mark" aria-hidden="true">
            The Marketplace
          </p>
          <p className="muted small">
            A learning project. Prices in US dollars. Payments are not real: nothing is charged.
          </p>
        </div>
      </footer>
    </>
  );
}
