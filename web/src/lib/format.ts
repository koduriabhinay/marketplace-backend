const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** Prices are integer cents end to end; only the screen ever sees dollars. */
export const formatMoney = (cents: number) => usd.format(cents / 100);

/**
 * "12.5" → 1250. Parses the text exactly instead of multiplying floats (0.29 * 100 is
 * 28.999999999999996). Returns null for anything that isn't a valid amount.
 */
export function parseMoney(input: string): number | null {
  const m = /^\s*\$?\s*(\d{1,9})(?:\.(\d{1,2}))?\s*$/.exec(input);
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return cents;
}

export const centsToInput = (cents: number) => (cents / 100).toFixed(2);

const dateFmt = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });
export const formatDate = (iso: string) => dateFmt.format(new Date(iso));

export const shortId = (id: string) => id.slice(0, 8);
