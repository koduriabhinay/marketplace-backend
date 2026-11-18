interface Props {
  offset: number;
  limit: number;
  total: number;
  onChange(offset: number): void;
}

export function Pager({ offset, limit, total, onChange }: Props) {
  if (total <= limit) return null;
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.ceil(total / limit);
  return (
    <nav className="pager" aria-label="Pagination">
      <button type="button" className="button secondary" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>
        Previous
      </button>
      <span>
        Page {page} of {pages}
      </span>
      <button type="button" className="button secondary" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>
        Next
      </button>
    </nav>
  );
}
