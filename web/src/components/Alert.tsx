import type { ReactNode } from 'react';
import { ApiError, errorMessage } from '../api/client';

export function Alert({ kind = 'error', children }: { kind?: 'error' | 'success' | 'info'; children: ReactNode }) {
  return (
    <div className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

/** An API error as a message, with the request ID support would ask for. */
export function ErrorAlert({ error }: { error: unknown }) {
  if (!error) return null;
  const id = error instanceof ApiError ? error.requestId : undefined;
  return (
    <Alert>
      {errorMessage(error)}
      {id && <small className="request-id">Reference: {id}</small>}
    </Alert>
  );
}
