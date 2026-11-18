#!/usr/bin/env node
/**
 * End-to-end smoke test of the full Docker Compose stack, through Nginx over HTTPS,
 * exactly as a client on the internet would see it. Run after `docker compose up`:
 *
 *   NODE_EXTRA_CA_CERTS=deploy/nginx/certs/tls.crt node scripts/smoke.mjs
 *
 * (NODE_EXTRA_CA_CERTS makes Node trust our self-signed certificate, so TLS is really
 * verified instead of switched off.)
 */
import { randomUUID } from 'node:crypto';

const BASE = process.env.SMOKE_BASE_URL ?? 'https://localhost:8443';
const HTTP_BASE = process.env.SMOKE_HTTP_URL ?? 'http://localhost:8080';
const PROMETHEUS = process.env.SMOKE_PROMETHEUS_URL ?? 'http://localhost:9090';
const PASSWORD = 'correct horse battery staple';

let failures = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
function check(cond, msg) {
  if (cond) return ok(msg);
  failures++;
  console.error(`  ✗ ${msg}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, json, text };
}

async function waitFor(what, fn, timeoutMs = 120_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await fn()) return ok(what);
    } catch {
      /* not up yet */
    }
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${what}`);
    await sleep(2_000);
  }
}

async function promQuery(q) {
  const res = await fetch(`${PROMETHEUS}/api/v1/query?query=${encodeURIComponent(q)}`);
  return (await res.json()).data.result;
}

async function register(role) {
  const r = await api('POST', '/api/v1/auth/register', {
    body: { email: `${role}-${randomUUID()}@example.com`, password: PASSWORD, name: `Smoke ${role}`, role },
  });
  if (r.status !== 201) throw new Error(`register ${role}: ${r.status} ${r.text}`);
  return r.json.data;
}

console.log(`Smoke testing ${BASE}`);

console.log('Edge (Nginx)');
await waitFor('API is reachable over HTTPS with a valid certificate', async () => (await api('GET', '/ready')).status === 200);
const redirect = await fetch(`${HTTP_BASE}/health`, { redirect: 'manual' });
check(redirect.status === 301 && redirect.headers.get('location')?.startsWith('https://'), 'plain HTTP redirects to HTTPS');
check((await api('GET', '/metrics')).status === 404, '/metrics is not exposed to the internet');
const health = await api('GET', '/health', { headers: { 'x-request-id': 'smoke-trace-123' } });
check(health.headers.get('x-request-id') === 'smoke-trace-123', 'request ID passes through Nginx to the API and back');
const ready = await api('GET', '/ready');
check(
  ['redis', 'replica'].every((n) => ready.json.checks.some((c) => c.name === n && c.ok)),
  'API sees Redis and the read replica',
);

console.log('Business flow');
const seller = await register('seller');
const customer = await register('customer');
const listing = await api('POST', '/api/v1/listings', {
  token: seller.accessToken,
  body: { title: 'Smoke Test Lamp', priceCents: 1500, stock: 5 },
});
check(listing.status === 201, 'seller creates a listing');
const listingId = listing.json.data.id;
check((await api('GET', `/api/v1/listings/${listingId}`)).status === 200, 'new listing is readable right away (read-your-writes)');

const key = `smoke-${randomUUID()}`;
const orderBody = { items: [{ listingId, quantity: 1 }] };
const first = await api('POST', '/api/v1/orders', { token: customer.accessToken, body: orderBody, headers: { 'idempotency-key': key } });
const retry = await api('POST', '/api/v1/orders', { token: customer.accessToken, body: orderBody, headers: { 'idempotency-key': key } });
check(first.status === 201, 'customer places an order');
check(retry.status === 201 && retry.headers.get('idempotent-replayed') === 'true' && retry.json.data.id === first.json.data.id, 'retry with the same Idempotency-Key replays the same order');
check((await api('GET', `/api/v1/listings/${listingId}`)).json.data.stock === 4, 'stock went down exactly once');

console.log('Image caching at the edge');
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const form = new FormData();
form.append('image', new Blob([png], { type: 'image/png' }), 'lamp.png');
const upload = await api('POST', `/api/v1/listings/${listingId}/images`, { token: seller.accessToken, body: form });
check(upload.status === 201, 'seller uploads an image through Nginx');
const imageUrl = upload.json?.data?.url;
const firstGet = await fetch(`${BASE}${imageUrl}`);
await firstGet.arrayBuffer();
const secondGet = await fetch(`${BASE}${imageUrl}`);
await secondGet.arrayBuffer();
check(firstGet.headers.get('x-cache-status') === 'MISS' && secondGet.headers.get('x-cache-status') === 'HIT', 'second image request is served from the Nginx cache');

console.log('Load balancing and observability');
for (let i = 0; i < 60; i++) await api('GET', '/api/v1/listings');
await waitFor('Prometheus scrapes 3 API instances and 2 workers', async () => {
  const up = await promQuery('up');
  const count = (job) => up.filter((r) => r.metric.job === job && r.value[1] === '1').length;
  return count('api') === 3 && count('worker') === 2;
});
await waitFor('requests were spread across all 3 API instances', async () => {
  const r = await promQuery('sum by (instance) (http_request_duration_seconds_count{route="/api/v1/listings/"})');
  return r.length === 3 && r.every((x) => Number(x.value[1]) > 0);
});
await waitFor('the worker published the order event from the outbox', async () => {
  const r = await promQuery('sum(outbox_events_published_total)');
  return r.length > 0 && Number(r[0].value[1]) >= 1;
});
// Reads right after a write go to the primary (read-your-writes) and are then cached, so
// wait out the grace period and ask for pages nobody has cached yet.
await sleep(6_000);
for (let offset = 1; offset <= 5; offset++) await api('GET', `/api/v1/listings?offset=${offset}`);
await waitFor('catalog reads are being served by the read replica', async () => {
  const r = await promQuery('sum(db_replica_reads_total{target="replica"})');
  return r.length > 0 && Number(r[0].value[1]) > 0;
});
const rules = await (await fetch(`${PROMETHEUS}/api/v1/rules`)).json();
check(rules.data.groups.some((g) => g.name === 'marketplace' && g.rules.length >= 5), 'alert rules are loaded');

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll smoke checks passed');
