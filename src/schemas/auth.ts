import { z } from 'zod';
import { safeText } from './common';

/**
 * bcrypt only reads the first 72 bytes of a password, so longer ones are rejected rather
 * than silently truncated. Length beats complexity rules: 12+ characters.
 */
export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .refine((p) => Buffer.byteLength(p, 'utf8') <= 72, 'Password must be at most 72 bytes');

const email = z.email().trim().toLowerCase().max(254);

export const registerSchema = z.strictObject({
  email,
  password: passwordSchema,
  name: safeText(2, 120),
  // Admin accounts are never self-registered; see `npm run create-admin`.
  role: z.enum(['customer', 'seller']),
});

export const loginSchema = z.strictObject({
  email,
  password: z.string().min(1).max(200),
});

export const refreshSchema = z.strictObject({
  refreshToken: z.string().min(20).max(200),
});

export const totpCodeSchema = z.string().regex(/^\d{6}$/, 'Must be a 6-digit code');

export const mfaVerifySchema = z.strictObject({
  mfaToken: z.string().min(20).max(1000),
  code: totpCodeSchema,
});

export const codeSchema = z.strictObject({ code: totpCodeSchema });

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
