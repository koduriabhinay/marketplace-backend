import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation } from 'react-router';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { ErrorAlert } from '../components/Alert';
import { safeRedirect } from './LoginPage';

export function RegisterPage() {
  const { register, user } = useAuth();
  const from = safeRedirect((useLocation().state as { from?: string } | null)?.from);
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'customer' as 'customer' | 'seller' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  // New sellers start on their dashboard; shoppers go back to where they were.
  if (user) return <Navigate to={user.role === 'seller' && from === '/' ? '/seller' : from} replace />;

  const fields = error instanceof ApiError ? error.fieldErrors() : {};
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await register(form);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel narrow">
      <h1>Create an account</h1>
      <form onSubmit={onSubmit} className="form" noValidate>
        <fieldset className="role-picker">
          <legend>I want to</legend>
          <label className={form.role === 'customer' ? 'selected' : ''}>
            <input type="radio" name="role" value="customer" checked={form.role === 'customer'} onChange={set('role')} />
            Shop
          </label>
          <label className={form.role === 'seller' ? 'selected' : ''}>
            <input type="radio" name="role" value="seller" checked={form.role === 'seller'} onChange={set('role')} />
            Sell
          </label>
        </fieldset>
        <label>
          {form.role === 'seller' ? 'Shop name' : 'Your name'}
          <input autoComplete={form.role === 'seller' ? 'organization' : 'name'} required minLength={2} maxLength={120} value={form.name} onChange={set('name')} />
          {fields.name && <span className="field-error">{fields.name}</span>}
        </label>
        <label>
          Email
          <input type="email" autoComplete="email" required value={form.email} onChange={set('email')} />
          {fields.email && <span className="field-error">{fields.email}</span>}
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            value={form.password}
            onChange={set('password')}
            aria-describedby="password-hint"
          />
          <span id="password-hint" className="muted small">
            At least 12 characters. A short sentence is easy to remember and hard to guess.
          </span>
          {fields.password && <span className="field-error">{fields.password}</span>}
        </label>
        {error && !Object.keys(fields).length ? <ErrorAlert error={error} /> : null}
        <button className="button" disabled={busy}>
          {busy ? 'Creating account…' : 'Create account'}
        </button>
      </form>
      <p className="muted">
        Already have an account? <Link to="/login">Log in</Link>
      </p>
    </section>
  );
}
