import { buildSet, buildWhere } from '../../src/repositories/postgres/sql';

describe('SQL builders', () => {
  it('buildSet only uses whitelisted columns and parameterizes values', () => {
    const { clause, values } = buildSet(
      { title: 'x', stock: 3, evil: 'ignored' } as Record<string, unknown>,
      { title: 'title', stock: 'stock' },
      2,
    );
    expect(clause).toBe('title = $2, stock = $3, updated_at = now()');
    expect(values).toEqual(['x', 3]);
  });

  it('buildWhere skips undefined filters', () => {
    expect(buildWhere(['deleted_at IS NULL'], [['a', undefined], ['b', 1]])).toEqual({
      clause: 'WHERE deleted_at IS NULL AND b = $1',
      values: [1],
    });
    expect(buildWhere([], [['a', undefined]])).toEqual({ clause: '', values: [] });
  });
});
