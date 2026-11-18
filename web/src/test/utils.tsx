import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { vi } from 'vitest';
import { AuthProvider } from '../auth/AuthProvider';
import { CartProvider } from '../cart/CartProvider';

export interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (call: Call) => Response | Promise<Response>;

export const json = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/**
 * Replaces fetch with a tiny router: "POST /auth/login" → handler. Every call is recorded
 * so tests can assert on headers (Idempotency-Key, X-Auth-Transport…).
 */
export function mockApi(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace(/^\/api\/v1/, '') + url.search;
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const call = { method, path, headers, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body };
    calls.push(call);
    const handler = routes[`${method} ${path}`] ?? routes[`${method} ${url.pathname.replace(/^\/api\/v1/, '')}`];
    if (!handler) return json(404, { error: { code: 'NOT_FOUND', message: `No mock for ${method} ${path}` } });
    return handler(call);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

export function renderApp(ui: ReactNode, { path = '/', route = '*' }: { path?: string; route?: string } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <CartProvider>
            <Routes>
              <Route path={route} element={ui} />
              <Route path="*" element={<p>Navigated away</p>} />
            </Routes>
          </CartProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

export const customer = {
  id: 'u1',
  email: 'jamie@example.com',
  role: 'customer' as const,
  sellerId: null,
  customerId: 'c1',
  twoFactorEnabled: false,
  createdAt: '2026-01-01T00:00:00.000Z',
};

export const listing = (over: Record<string, unknown> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  sellerId: 's1',
  title: 'Walnut desk lamp',
  description: 'Warm light.',
  priceCents: 4900,
  currency: 'USD',
  stock: 10,
  status: 'active',
  primaryImageUrl: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});
