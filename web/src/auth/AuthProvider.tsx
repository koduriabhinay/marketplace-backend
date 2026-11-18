import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { refreshSession, session } from '../api/client';
import { authApi } from '../api/endpoints';
import type { Session, User } from '../api/types';

type Status = 'loading' | 'anonymous' | 'authenticated';

export type LoginOutcome = { done: true } | { done: false; mfaToken: string };

interface AuthContextValue {
  status: Status;
  user: User | null;
  login(email: string, password: string): Promise<LoginOutcome>;
  verifyMfa(mfaToken: string, code: string): Promise<void>;
  register(input: Parameters<typeof authApi.register>[0]): Promise<void>;
  logout(): Promise<void>;
  /** After a token-issuing call elsewhere (enabling 2FA rotates the session). */
  adopt(s: Session): Promise<void>;
  reloadUser(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>(() => (session.mightExist ? 'loading' : 'anonymous'));
  const [user, setUser] = useState<User | null>(null);
  const queryClient = useQueryClient();

  const endSession = useCallback(() => {
    session.clear();
    setUser(null);
    setStatus('anonymous');
    queryClient.removeQueries({ predicate: (q) => q.meta?.private === true });
  }, [queryClient]);

  const adopt = useCallback(async (s: Session) => {
    session.start(s.accessToken);
    setUser(await authApi.me());
    setStatus('authenticated');
  }, []);

  // On page load: if this browser had a session, swap the cookie for an access token.
  useEffect(() => {
    if (!session.mightExist) return;
    let cancelled = false;
    void (async () => {
      const token = await refreshSession();
      if (cancelled) return;
      if (!token) return endSession();
      try {
        const me = await authApi.me();
        if (!cancelled) {
          setUser(me);
          setStatus('authenticated');
        }
      } catch {
        if (!cancelled) endSession();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [endSession]);

  // A request found the session dead (refresh failed): show the logged-out UI.
  useEffect(() => {
    session.onEnded(endSession);
    return () => session.onEnded(null);
  }, [endSession]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      async login(email, password) {
        const result = await authApi.login(email, password);
        if ('mfaRequired' in result) return { done: false, mfaToken: result.mfaToken };
        await adopt(result);
        return { done: true };
      },
      async verifyMfa(mfaToken, code) {
        await adopt(await authApi.verifyMfa(mfaToken, code));
      },
      async register(input) {
        const result = await authApi.register(input);
        session.start(result.accessToken);
        setUser(result.user);
        setStatus('authenticated');
      },
      async logout() {
        try {
          await authApi.logout();
        } finally {
          endSession();
        }
      },
      adopt,
      async reloadUser() {
        setUser(await authApi.me());
      },
    }),
    [status, user, adopt, endSession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
