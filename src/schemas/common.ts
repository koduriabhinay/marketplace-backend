import { z } from 'zod';

export const idParamSchema = z.object({ id: z.uuid() });

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export type Pagination = z.infer<typeof paginationSchema>;

export interface Page<T> {
  data: T[];
  pagination: { limit: number; offset: number; total: number };
}
