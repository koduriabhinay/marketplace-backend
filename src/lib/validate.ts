import type { z } from 'zod';
import { ValidationError } from './errors';

/**
 * Server-side validation: parse untrusted input against a schema and return typed data.
 * Unknown fields are rejected by strict schemas; bad input becomes a 400 with field details.
 */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}
