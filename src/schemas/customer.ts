import { z } from 'zod';

export const createCustomerSchema = z.strictObject({
  name: z.string().trim().min(2).max(120),
  email: z.email().trim().toLowerCase().max(254),
});

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

export interface Customer {
  id: string;
  name: string;
  email: string;
  createdAt: string;
  updatedAt: string;
}
