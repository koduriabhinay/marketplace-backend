/** Shapes returned by the API (mirrors src/schemas/* on the backend). */

export type Role = 'customer' | 'seller' | 'admin';

export interface User {
  id: string;
  email: string;
  role: Role;
  sellerId: string | null;
  customerId: string | null;
  twoFactorEnabled: boolean;
  createdAt: string;
}

/** In cookie mode the refresh token never reaches JavaScript: only the access token does. */
export interface Session {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

export type LoginResult = Session | { mfaRequired: true; mfaToken: string };

export interface Page<T> {
  data: T[];
  pagination: { limit: number; offset: number; total: number };
}

export type ListingStatus = 'active' | 'inactive';

export interface Listing {
  id: string;
  sellerId: string;
  title: string;
  description: string;
  priceCents: number;
  currency: 'USD';
  stock: number;
  status: ListingStatus;
  primaryImageUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListingInput {
  title: string;
  description: string;
  priceCents: number;
  stock: number;
  status: ListingStatus;
}

export interface ListingImage {
  id: string;
  listingId: string;
  contentType: string;
  sizeBytes: number;
  url: string;
  createdAt: string;
}

export interface Seller {
  id: string;
  name: string;
  createdAt: string;
}

export interface OrderItem {
  listingId: string;
  quantity: number;
  unitPriceCents: number;
}

export interface Order {
  id: string;
  customerId: string;
  status: 'placed' | 'cancelled';
  totalCents: number;
  currency: 'USD';
  items: OrderItem[];
  createdAt: string;
  updatedAt: string;
}

export const EVENT_TYPES = ['order.placed', 'order.cancelled'] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface WebhookEndpoint {
  id: string;
  sellerId: string;
  url: string;
  events: EventType[];
  active: boolean;
  createdAt: string;
}

export interface WebhookDelivery {
  id: string;
  eventId: string;
  eventType: string;
  status: 'pending' | 'succeeded' | 'dead';
  attempts: number;
  nextAttemptAt: string | null;
  lastStatusCode: number | null;
  lastError: string | null;
  createdAt: string;
  deliveredAt: string | null;
}
