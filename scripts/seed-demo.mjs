#!/usr/bin/env node
/**
 * Fills the shop with a demo seller and a dozen illustrated products, so the website has
 * something to show. Uses the public API like any client (no database access). The pictures
 * are original illustrations in scripts/seed-assets/ (the .svg files are the sources).
 *
 *   NODE_EXTRA_CA_CERTS=deploy/nginx/certs/tls.crt node scripts/seed-demo.mjs   # Docker stack
 *   SEED_BASE_URL=http://localhost:3000 node scripts/seed-demo.mjs              # npm run dev
 *
 * Prints the demo seller's login at the end.
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const BASE = process.env.SEED_BASE_URL ?? 'https://localhost:8443';
const email = `demo-seller-${randomBytes(3).toString('hex')}@example.com`;
const password = `demo-${randomBytes(6).toString('hex')}-password`;

const PRODUCTS = [
  ['mug', 'Hand-thrown stoneware mug', 'Speckled glaze, holds 350 ml. Each one is slightly different.', 3400, 14],
  ['lamp', 'Walnut desk lamp', 'Turned walnut base, linen shade, warm 2700K bulb included.', 12800, 4],
  ['towel', 'Indigo linen tea towel', 'Stonewashed linen dyed with natural indigo.', 1800, 30],
  ['notebook', 'Brass pocket notebook cover', 'Fits A6 notebooks. Develops a patina with use.', 4600, 8],
  ['candles', 'Beeswax candle trio', 'Rolled by hand, unscented, about 8 hours each.', 2200, 20],
  ['board', 'Oak serving board', 'Single piece of European oak, finished with food-safe oil.', 5900, 6],
  ['throw', 'Wool throw, moss', 'Woven on a 1950s loom from undyed and moss-green wool.', 14500, 3],
  ['vase', 'Ceramic bud vase', 'Matte white, 12 cm tall. For one stem, or two.', 2600, 12],
  ['keyfob', 'Leather key fob', 'Vegetable-tanned leather, saddle-stitched.', 1500, 40],
  ['plate', 'Enamel camp plate', 'Blue rim, dishwasher safe, made to be dropped.', 1900, 25],
  ['print', 'Letterpress print, "Market Day"', 'A3, two colours, printed on cotton paper. Edition of 50.', 4200, 2],
  ['trivet', 'Cast-iron trivet', 'Heavy, flat, and quietly handsome.', 3100, 9],
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
for (const [art, title, description, priceCents, stock] of PRODUCTS) {
  const listing = await call('POST', '/listings', { title, description, priceCents, stock }, accessToken);
  const form = new FormData();
  const png = await readFile(new URL(`./seed-assets/${art}.png`, import.meta.url));
  form.append('image', new Blob([png], { type: 'image/png' }), `${art}.png`);
  const up = await fetch(`${BASE}/api/v1/listings/${listing.id}/images`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}` },
    body: form,
  });
  if (!up.ok) throw new Error(`upload ${art}: ${up.status} ${await up.text()}`);
  console.log(`  + ${title}`);
}
console.log(`\nSeeded ${PRODUCTS.length} products from ${BASE}`);
console.log(`Demo seller login: ${email} / ${password}`);
