#!/usr/bin/env node
/**
 * Fills the shop with a demo seller and a dozen products, so the website has something to
 * show. Uses the public API like any client (no database access).
 *
 *   NODE_EXTRA_CA_CERTS=deploy/nginx/certs/tls.crt node scripts/seed-demo.mjs   # Docker stack
 *   SEED_BASE_URL=http://localhost:3000 node scripts/seed-demo.mjs              # npm run dev
 *
 * Prints the demo seller's login at the end.
 */
import { randomBytes } from 'node:crypto';

const BASE = process.env.SEED_BASE_URL ?? 'https://localhost:8443';
const email = `demo-seller-${randomBytes(3).toString('hex')}@example.com`;
const password = `demo-${randomBytes(6).toString('hex')}-password`;

const PRODUCTS = [
  ['Hand-thrown stoneware mug', 'Speckled glaze, holds 350 ml. Each one is slightly different.', 3400, 14],
  ['Walnut desk lamp', 'Turned walnut base, linen shade, warm 2700K bulb included.', 12800, 4],
  ['Indigo linen tea towel', 'Stonewashed linen dyed with natural indigo.', 1800, 30],
  ['Brass pocket notebook cover', 'Fits A6 notebooks. Develops a patina with use.', 4600, 8],
  ['Beeswax candle trio', 'Rolled by hand, unscented, about 8 hours each.', 2200, 20],
  ['Oak serving board', 'Single piece of European oak, finished with food-safe oil.', 5900, 6],
  ['Wool throw, moss', 'Woven on a 1950s loom from undyed and moss-green wool.', 14500, 3],
  ['Ceramic bud vase', 'Matte white, 12 cm tall. For one stem, or two.', 2600, 12],
  ['Leather key fob', 'Vegetable-tanned leather, saddle-stitched.', 1500, 40],
  ['Enamel camp plate', 'Blue rim, dishwasher safe, made to be dropped.', 1900, 25],
  ['Letterpress print, "Market Day"', 'A3, two colours, printed on cotton paper. Edition of 50.', 4200, 2],
  ['Cast-iron trivet', 'Heavy, flat, and quietly handsome.', 3100, 9],
];

async function call(method, path, body, token) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json.error ?? json)}`);
  return json.data;
}

const { accessToken } = await call('POST', '/auth/register', { email, password, name: 'Fieldhouse Goods', role: 'seller' });
for (const [title, description, priceCents, stock] of PRODUCTS) {
  await call('POST', '/listings', { title, description, priceCents, stock }, accessToken);
  console.log(`  + ${title}`);
}
console.log(`\nSeeded ${PRODUCTS.length} products from ${BASE}`);
console.log(`Demo seller login: ${email} / ${password}`);
