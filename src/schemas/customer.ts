import { z } from 'zod';
import { safeText } from './common';

export const createCustomerSchema = z.strictObject({
  name: safeText(2, 120),
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
