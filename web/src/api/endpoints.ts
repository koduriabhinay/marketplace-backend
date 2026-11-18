/** Typed wrappers for every API call the website makes. */
import { api, apiData } from './client';
import type {
  EventType,
  Listing,
  ListingImage,
  ListingInput,
  ListingStatus,
  LoginResult,
  Order,
  Page,
  Seller,
  Session,
  User,
  WebhookDelivery,
  WebhookEndpoint,
} from './types';

const qs = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
};

export const authApi = {
  register: (input: { email: string; password: string; name: string; role: 'customer' | 'seller' }) =>
    apiData<Session & { user: User }>('/auth/register', { method: 'POST', body: input }),
  login: (email: string, password: string) =>
    apiData<LoginResult>('/auth/login', { method: 'POST', body: { email, password } }),
  verifyMfa: (mfaToken: string, code: string) =>
    apiData<Session>('/auth/2fa/verify', { method: 'POST', body: { mfaToken, code } }),
  logout: () => api<void>('/auth/logout', { method: 'POST' }),
  me: () => apiData<User>('/auth/me'),
  setupTotp: () => apiData<{ secret: string; otpauthUri: string }>('/auth/2fa/setup', { method: 'POST' }),
  enableTotp: (code: string) => apiData<Session>('/auth/2fa/enable', { method: 'POST', body: { code } }),
  disableTotp: (code: string) => api<void>('/auth/2fa/disable', { method: 'POST', body: { code } }),
};

export const listingsApi = {
  list: (q: { limit?: number; offset?: number; sellerId?: string; status?: ListingStatus }, signal?: AbortSignal) =>
    api<Page<Listing>>(`/listings${qs(q)}`, { signal }),
  get: (id: string, signal?: AbortSignal) => apiData<Listing>(`/listings/${id}`, { signal }),
  create: (input: ListingInput) => apiData<Listing>('/listings', { method: 'POST', body: input }),
  update: (id: string, patch: Partial<ListingInput>) =>
    apiData<Listing>(`/listings/${id}`, { method: 'PATCH', body: patch }),
  remove: (id: string) => api<void>(`/listings/${id}`, { method: 'DELETE' }),
  images: (id: string, signal?: AbortSignal) => apiData<ListingImage[]>(`/listings/${id}/images`, { signal }),
  uploadImage: (id: string, file: File) => {
    const form = new FormData();
    form.append('image', file);
    return apiData<ListingImage>(`/listings/${id}/images`, { method: 'POST', body: form });
  },
};

export const sellersApi = {
  get: (id: string, signal?: AbortSignal) => apiData<Seller>(`/sellers/${id}`, { signal }),
};

export const ordersApi = {
  /** The Idempotency-Key makes a retried checkout (timeout, double click) place one order. */
  place: (items: { listingId: string; quantity: number }[], idempotencyKey: string) =>
    apiData<Order>('/orders', { method: 'POST', body: { items }, headers: { 'Idempotency-Key': idempotencyKey } }),
  list: (q: { limit?: number; offset?: number }, signal?: AbortSignal) => api<Page<Order>>(`/orders${qs(q)}`, { signal }),
  cancel: (id: string) => apiData<Order>(`/orders/${id}/cancel`, { method: 'POST' }),
};

export const webhooksApi = {
  list: (sellerId: string) => apiData<WebhookEndpoint[]>(`/sellers/${sellerId}/webhooks`),
  create: (sellerId: string, url: string, events: EventType[]) =>
    apiData<WebhookEndpoint & { secret: string }>(`/sellers/${sellerId}/webhooks`, {
      method: 'POST',
      body: { url, events },
    }),
  remove: (sellerId: string, id: string) => api<void>(`/sellers/${sellerId}/webhooks/${id}`, { method: 'DELETE' }),
  deliveries: (sellerId: string, id: string, offset = 0) =>
    api<Page<WebhookDelivery>>(`/sellers/${sellerId}/webhooks/${id}/deliveries${qs({ limit: 20, offset })}`),
};
