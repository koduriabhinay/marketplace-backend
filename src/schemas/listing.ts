import { z } from 'zod';
import { paginationSchema } from './common';

export const LISTING_STATUSES = ['active', 'inactive'] as const;

/** Money is stored as integer cents to avoid floating-point rounding errors. */
export const createListingSchema = z.strictObject({
  sellerId: z.uuid(),
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(5000).default(''),
  priceCents: z.number().int().min(1).max(100_000_000),
  currency: z.literal('USD').default('USD'),
  stock: z.number().int().min(0).max(1_000_000),
  status: z.enum(LISTING_STATUSES).default('active'),
});

export const updateListingSchema = createListingSchema
  .omit({ sellerId: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' });

export const listListingsQuerySchema = paginationSchema.extend({
  sellerId: z.uuid().optional(),
  status: z.enum(LISTING_STATUSES).optional(),
});

export type CreateListingInput = z.infer<typeof createListingSchema>;
export type UpdateListingInput = z.infer<typeof updateListingSchema>;
export type ListListingsQuery = z.infer<typeof listListingsQuerySchema>;

export interface Listing {
  id: string;
  sellerId: string;
  title: string;
  description: string;
  priceCents: number;
  currency: 'USD';
  stock: number;
  status: (typeof LISTING_STATUSES)[number];
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}
