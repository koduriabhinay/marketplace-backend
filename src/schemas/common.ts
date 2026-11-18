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

/**
 * Plain-text field that can't carry HTML/script markup. JSON APIs don't render HTML, but
 * names and titles get shown in web pages, emails and admin tools that might forget to
 * escape them, so we refuse angle brackets and control characters at the door (XSS defence
 * in depth; output encoding by the frontend is still the primary defence).
 */
export const safeText = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    // eslint-disable-next-line no-control-regex
    .refine((s) => !/[<>\u0000-\u001f\u007f]/.test(s), 'Must not contain < > or control characters');
