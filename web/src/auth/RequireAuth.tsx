import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import type { Role } from '../api/types';
import { Spinner } from '../components/Spinner';
import { useAuth } from './AuthProvider';

/**
 * Hides pages from logged-out users and wrong roles. This is a convenience for the UI
 * only: the API enforces every permission itself, whatever the browser does.
 */
export function RequireAuth({ role, children }: { role?: Role; children: ReactNode }) {
  const { status, user } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <Spinner label="Checking your session" />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (role && user.role !== role) {
    return (
      <div className="panel">
        <h1>Not available</h1>
        <p>This page is for {role} accounts. You are logged in as a {user.role}.</p>
      </div>
    );
  }
  return <>{children}</>;
}
