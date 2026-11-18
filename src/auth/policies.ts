import { ForbiddenError, NotFoundError, UnprocessableError } from '../lib/errors';
import type { AuthUser } from './types';

/**
 * Authorization rules in one place. Authentication says WHO you are; these decide WHAT
 * you may touch. Ownership is always derived from the token, never trusted from the body.
 */

export const isAdmin = (u: AuthUser) => u.role === 'admin';

/** Which seller a new listing belongs to. */
export function resolveSellerForCreate(user: AuthUser, requested?: string): string {
  if (isAdmin(user)) {
    if (!requested) throw new UnprocessableError('Admins must specify sellerId');
    return requested;
  }
  if (user.role !== 'seller' || !user.sellerId) throw new ForbiddenError('Only sellers can create listings');
  if (requested && requested !== user.sellerId) throw new ForbiddenError('Sellers can only list their own products');
  return user.sellerId;
}

export function assertCanManageSeller(user: AuthUser, sellerId: string) {
  if (!isAdmin(user) && user.sellerId !== sellerId) throw new ForbiddenError();
}

/** Which customer an order is for. */
export function resolveCustomerForOrder(user: AuthUser, requested?: string): string {
  if (isAdmin(user)) {
    if (!requested) throw new UnprocessableError('Admins must specify customerId');
    return requested;
  }
  if (user.role !== 'customer' || !user.customerId) throw new ForbiddenError('Only customers can place orders');
  if (requested && requested !== user.customerId) throw new ForbiddenError('Customers can only order for themselves');
  return user.customerId;
}

/**
 * Someone else's order answers 404, not 403: confirming that an order ID exists would
 * leak information (an IDOR probe can't tell "not yours" from "doesn't exist").
 */
export function assertCanSeeCustomerResource(user: AuthUser, customerId: string, resource: string, id: string) {
  if (!isAdmin(user) && user.customerId !== customerId) throw new NotFoundError(resource, id);
}
