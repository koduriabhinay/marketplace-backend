import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { ErrorAlert } from '../components/Alert';

/** Only same-site paths: never bounce to a URL someone put in the link (open redirect). */
export const safeRedirect = (from: unknown) =>
  typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') ? from : '/';

export function LoginPage() {
  const { login, verifyMfa, user } = useAuth();
  const from = safeRedirect((useLocation().state as { from?: string } | null)?.from);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  // Once logged in (here, or already), go back to where the visitor was headed.
  if (user) return <Navigate to={from} replace />;

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const onLogin = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const outcome = await login(email, password);
      if (!outcome.done) setMfaToken(outcome.mfaToken);
    });
  };

  const onCode = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await verifyMfa(mfaToken!, code);
    });
  };

  if (mfaToken) {
    return (
      <section className="panel narrow">
        <h1>Two-factor check</h1>
        <p>Enter the 6-digit code from your authenticator app.</p>
        <form onSubmit={onCode} className="form">
          <label>
            Code
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              required
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
          </label>
          <ErrorAlert error={error} />
          <button className="button" disabled={busy || code.length !== 6}>
            {busy ? 'Checking…' : 'Verify'}
          </button>
          <button type="button" className="link-button" onClick={() => setMfaToken(null)}>
            Start over
          </button>
        </form>
      </section>
    );
  }

  return (
    <section className="panel narrow">
      <h1>Log in</h1>
      <form onSubmit={onLogin} className="form">
        <label>
          Email
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <ErrorAlert error={error} />
        <button className="button" disabled={busy}>
          {busy ? 'Logging in…' : 'Log in'}
        </button>
      </form>
      <p className="muted">
        New here? <Link to="/register" state={{ from }}>Create an account</Link>
      </p>
    </section>
  );
}
