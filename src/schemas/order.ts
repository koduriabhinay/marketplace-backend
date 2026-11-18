import { z } from 'zod';
import { paginationSchema } from './common';

export const ORDER_STATUSES = ['placed', 'cancelled'] as const;

export const createOrderSchema = z.strictObject({
  customerId: z.uuid(),
  items: z
    .array(
      z.strictObject({
        listingId: z.uuid(),
        quantity: z.number().int().min(1).max(100),
      }),
    )
    .min(1)
    .max(50)
    .refine((items) => new Set(items.map((i) => i.listingId)).size === items.length, {
      message: 'Each listing may appear only once; combine quantities instead',
    }),
});

export const listOrdersQuerySchema = paginationSchema.extend({
  customerId: z.uuid().optional(),
  status: z.enum(ORDER_STATUSES).optional(),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;

export interface OrderItem {
  listingId: string;
  quantity: number;
  unitPriceCents: number;
}

export interface Order {
  id: string;
  customerId: string;
  status: (typeof ORDER_STATUSES)[number];
  totalCents: number;
  currency: 'USD';
  items: OrderItem[];
  createdAt: string;
  updatedAt: string;
}
