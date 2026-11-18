import bcrypt from 'bcryptjs';
import { env } from '../config/env';

/**
 * bcrypt is deliberately slow (2^rounds iterations) so a stolen hash table takes years to
 * crack instead of seconds. 12 rounds is ~250 ms per hash on a modern CPU.
 */
export const hashPassword = (password: string) => bcrypt.hash(password, env.BCRYPT_ROUNDS);

export const verifyPassword = (password: string, hash: string) => bcrypt.compare(password, hash);

/**
 * Used when a login email doesn't exist: we still run a full bcrypt compare so the
 * response takes the same time, and attackers can't discover which emails are registered
 * by timing the endpoint.
 */
export const DUMMY_HASH = bcrypt.hashSync('timing-attack-mitigation-placeholder', env.BCRYPT_ROUNDS);
