import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router';
import { RequireAuth } from './auth/RequireAuth';
import { Layout } from './components/Layout';
import { Spinner } from './components/Spinner';
import { CartPage } from './pages/CartPage';
import { CatalogPage } from './pages/CatalogPage';
import { ListingPage } from './pages/ListingPage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { OrdersPage } from './pages/OrdersPage';
import { RegisterPage } from './pages/RegisterPage';

// Code splitting: shoppers never download the seller dashboard or the QR-code library.
const AccountPage = lazy(() => import('./pages/AccountPage').then((m) => ({ default: m.AccountPage })));
const SellerDashboard = lazy(() => import('./pages/seller/SellerDashboard').then((m) => ({ default: m.SellerDashboard })));
const ListingEditor = lazy(() => import('./pages/seller/ListingEditor').then((m) => ({ default: m.ListingEditor })));
const WebhooksPage = lazy(() => import('./pages/seller/WebhooksPage').then((m) => ({ default: m.WebhooksPage })));

export function App() {
  return (
    <Suspense fallback={<Spinner />}>
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<CatalogPage />} />
        <Route path="listings/:id" element={<ListingPage />} />
        <Route path="cart" element={<CartPage />} />
        <Route path="login" element={<LoginPage />} />
        <Route path="register" element={<RegisterPage />} />
        <Route path="account" element={<RequireAuth><AccountPage /></RequireAuth>} />
        <Route path="orders" element={<RequireAuth role="customer"><OrdersPage /></RequireAuth>} />
        <Route path="seller" element={<RequireAuth role="seller"><SellerDashboard /></RequireAuth>} />
        <Route path="seller/listings/new" element={<RequireAuth role="seller"><ListingEditor /></RequireAuth>} />
        <Route path="seller/listings/:id" element={<RequireAuth role="seller"><ListingEditor /></RequireAuth>} />
        <Route path="seller/webhooks" element={<RequireAuth role="seller"><WebhooksPage /></RequireAuth>} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
    </Suspense>
  );
}
