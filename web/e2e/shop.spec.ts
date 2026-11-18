import { expect, test, type Page } from '@playwright/test';

// A real 1×1 PNG, so the API's file-type sniffing accepts it.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const PASSWORD = 'correct horse battery staple';
const run = Date.now().toString(36);
const title = `E2E walnut lamp ${run}`;

async function register(page: Page, role: 'Shop' | 'Sell', name: string, email: string) {
  await page.goto('/register');
  await page.getByLabel(role).check();
  await page.getByLabel(role === 'Sell' ? 'Shop name' : 'Your name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
}

test('a seller lists a product with a photo, and a customer buys it and cancels', async ({ page }) => {
  // --- Seller -------------------------------------------------------------------------
  await register(page, 'Sell', 'E2E Woodworks', `seller-${run}@example.com`);
  await expect(page.getByRole('heading', { name: 'Seller dashboard' })).toBeVisible();

  await page.getByRole('link', { name: 'New listing' }).first().click();
  await page.getByLabel('Title').fill(title);
  await page.getByLabel('Description').fill('Hand-turned walnut.\nWarm light.');
  await page.getByLabel('Price (USD)').fill('12.50');
  await page.getByLabel('Stock').fill('5');
  await page.getByRole('button', { name: 'Create listing' }).click();
  await expect(page.getByRole('heading', { name: 'Edit listing' })).toBeVisible();

  await page.locator('input[type=file]').setInputFiles({ name: 'lamp.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByText('Main photo')).toBeVisible();

  await page.getByRole('link', { name: '← Seller dashboard' }).click();
  await expect(page.getByRole('row', { name: new RegExp(title) })).toContainText('$12.50');
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByRole('link', { name: 'Log in' })).toBeVisible();

  // --- Customer -----------------------------------------------------------------------
  await register(page, 'Shop', 'E2E Shopper', `customer-${run}@example.com`);
  await expect(page.getByRole('heading', { level: 1, name: /Market day/ })).toBeVisible();

  const card = page.getByRole('article').filter({ hasText: title });
  await expect(card).toBeVisible();
  // The thumbnail really loads (through Nginx's image cache in the full stack).
  await expect(card.getByRole('img')).toHaveJSProperty('complete', true);
  expect(await card.getByRole('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await card.click();

  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.getByText('Sold by E2E Woodworks')).toBeVisible();
  await page.getByLabel('Quantity').fill('2');
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await page.getByRole('link', { name: 'Go to cart' }).click();

  await expect(page.locator('.summary-row')).toContainText('$25.00');
  await page.getByRole('button', { name: 'Place order' }).click();
  await expect(page.getByText(/Thank you! Order .* is placed/)).toBeVisible();
  await expect(page.getByRole('link', { name: title })).toBeVisible();

  // The session survives a reload: the httpOnly cookie is swapped for a new access token.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'My orders' })).toBeVisible();
  const order = page.getByRole('listitem').filter({ hasText: title });
  await expect(order).toContainText('Placed');

  page.once('dialog', (d) => void d.accept());
  await order.getByRole('button', { name: 'Cancel order' }).click();
  await expect(order).toContainText('Cancelled');

  // Stock went back: 5 available again on the product page.
  await page.goto('/');
  await page.getByRole('article').filter({ hasText: title }).click();
  await expect(page.getByText('Only 5 left in stock')).toBeVisible();
});

test('protected pages send logged-out visitors to the login page', async ({ page }) => {
  await page.goto('/seller');
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
  const cookies = await page.context().cookies();
  expect(cookies.find((c) => c.name === 'mp_refresh')).toBeUndefined();
});
