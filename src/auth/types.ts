export const ROLES = ['customer', 'seller', 'admin'] as const;
export type Role = (typeof ROLES)[number];

/** Who is making the request, as proven by their access token. */
export interface AuthUser {
  id: string;
  role: Role;
  sellerId: string | null;
  customerId: string | null;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}
