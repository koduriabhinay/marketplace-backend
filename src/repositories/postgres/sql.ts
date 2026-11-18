import type { Page, Pagination } from '../../schemas/common';

export const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/**
 * Builds "SET a = $1, b = $2" from a patch object. Column names come ONLY from the
 * hard-coded `columns` map (never from user input) and every value is a bind parameter,
 * so this cannot be used for SQL injection.
 */
export function buildSet<T extends object>(
  patch: T,
  columns: Record<keyof T & string, string>,
  startAt = 1,
): { clause: string; values: unknown[] } {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(columns) as [string, string][]) {
    const value = (patch as Record<string, unknown>)[key];
    if (value === undefined) continue;
    values.push(value);
    sets.push(`${column} = $${startAt + values.length - 1}`);
  }
  sets.push('updated_at = now()');
  return { clause: sets.join(', '), values };
}

export function page<T>(data: T[], total: number, { limit, offset }: Pagination): Page<T> {
  return { data, pagination: { limit, offset, total } };
}

/** Builds a "WHERE ..." clause from optional equality filters, all parameterized. */
export function buildWhere(
  base: string[],
  filters: [column: string, value: unknown][],
): { clause: string; values: unknown[] } {
  const conds = [...base];
  const values: unknown[] = [];
  for (const [column, value] of filters) {
    if (value === undefined) continue;
    values.push(value);
    conds.push(`${column} = $${values.length}`);
  }
  return { clause: conds.length ? `WHERE ${conds.join(' AND ')}` : '', values };
}
