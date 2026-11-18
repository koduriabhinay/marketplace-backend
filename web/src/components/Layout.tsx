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
      <Ticker />
      <header className="site-header">
        <div className="container header-inner">
          <Link to="/" className="wordmark" aria-label="Marketplace home">
            Market
            <Burst className="wordmark-burst" />
            place
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
          <p className="footer-mark" aria-hidden="true">
            Marketplace
          </p>
          <p className="muted small">
            A learning project. Prices in US dollars. Payments are not real: nothing is charged.
          </p>
        </div>
      </footer>
    </>
  );
}

/** The twelve-point star used like a printer's mark across the site. */
export function Burst({ className = '' }: { className?: string }) {
  return (
    <svg className={`burst ${className}`} viewBox="0 0 100 100" aria-hidden="true">
      <path d="M50 0l9 22 19-14-3 24 24-3-14 19 22 9-22 9 14 19-24-3 3 24-19-14-9 22-9-22-19 14 3-24-24 3 14-19L0 50l22-9L8 22l24 3-3-24 19 14z" />
    </svg>
  );
}

const TICKER = ['Independent sellers', 'Live stock', 'Checkout that never charges twice', 'Made by people', 'New pieces weekly'];

/** A scrolling strip, like the edge of a printed flyer. Decorative: hidden from screen readers. */
function Ticker() {
  const run = (
    <span className="ticker-run">
      {TICKER.map((t) => (
        <span key={t}>
          {t} <Burst />
        </span>
      ))}
    </span>
  );
  return (
    <div className="ticker" aria-hidden="true">
      <div className="ticker-track">
        {run}
        {run}
        {run}
      </div>
    </div>
  );
}
