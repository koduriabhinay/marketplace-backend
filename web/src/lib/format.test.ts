import { centsToInput, formatMoney, parseMoney } from './format';

describe('money helpers', () => {
  it('formats integer cents as dollars', () => {
    expect(formatMoney(4900)).toBe('$49.00');
    expect(formatMoney(123456)).toBe('$1,234.56');
  });

  it('parses typed prices exactly, without float rounding', () => {
    expect(parseMoney('0.29')).toBe(29); // 0.29 * 100 would be 28.999…
    expect(parseMoney('19.9')).toBe(1990);
    expect(parseMoney('$ 5')).toBe(500);
    expect(parseMoney('1.234')).toBeNull();
    expect(parseMoney('-3')).toBeNull();
    expect(parseMoney('abc')).toBeNull();
    expect(centsToInput(1990)).toBe('19.90');
  });
});
