import type { Page, Pagination } from '../schemas/common';
import type { Customer } from '../schemas/customer';
import type { Listing, ListListingsQuery } from '../schemas/listing';
import type { CreateOrderInput, ListOrdersQuery, Order } from '../schemas/order';
import type { Seller } from '../schemas/seller';

/**
 * Repositories hide WHERE and HOW data is stored. Services and routes depend only on
 * these interfaces, so storage can change without touching business logic or HTTP.
 */
export interface SellerRepository {
  create(seller: Omit<Seller, 'createdAt' | 'updatedAt'>): Promise<Seller>;
  findById(id: string): Promise<Seller | null>;
  findByEmail(email: string): Promise<Seller | null>;
  list(page: Pagination): Promise<Page<Seller>>;
  update(id: string, patch: Partial<Pick<Seller, 'name' | 'email'>>): Promise<Seller | null>;
}

export interface CustomerRepository {
  create(customer: Omit<Customer, 'createdAt' | 'updatedAt'>): Promise<Customer>;
  findById(id: string): Promise<Customer | null>;
}

export type NewListing = Omit<Listing, 'createdAt' | 'updatedAt' | 'deletedAt'>;
export type ListingPatch = Partial<
  Pick<Listing, 'title' | 'description' | 'priceCents' | 'currency' | 'stock' | 'status'>
>;

export interface ListingRepository {
  create(listing: NewListing): Promise<Listing>;
  /** Returns null for missing AND soft-deleted listings. */
  findById(id: string): Promise<Listing | null>;
  list(query: ListListingsQuery): Promise<Page<Listing>>;
  update(id: string, patch: ListingPatch): Promise<Listing | null>;
  softDelete(id: string): Promise<boolean>;
}

export interface OrderRepository {
  /** Atomically checks and reserves stock, then records the order. */
  place(id: string, input: CreateOrderInput): Promise<Order>;
  findById(id: string): Promise<Order | null>;
  list(query: ListOrdersQuery): Promise<Page<Order>>;
  /** Atomically cancels a placed order and returns its stock. */
  cancel(id: string): Promise<Order>;
}

export interface Repositories {
  sellers: SellerRepository;
  customers: CustomerRepository;
  listings: ListingRepository;
  orders: OrderRepository;
}
