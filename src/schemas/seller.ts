import { z } from 'zod';
import { paginationSchema } from './common';

export const createSellerSchema = z.strictObject({
  name: z.string().trim().min(2).max(120),
  email: z.email().trim().toLowerCase().max(254),
});

export const updateSellerSchema = createSellerSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' });

export const listSellersQuerySchema = paginationSchema;

export type CreateSellerInput = z.infer<typeof createSellerSchema>;
export type UpdateSellerInput = z.infer<typeof updateSellerSchema>;

export interface Seller {
  id: string;
  name: string;
  email: string;
  createdAt: string;
  updatedAt: string;
}
