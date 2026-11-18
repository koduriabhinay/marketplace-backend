import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { session } from '../api/client';
import { customer, json, mockApi, renderApp } from '../test/utils';
import { LoginPage, safeRedirect } from './LoginPage';

afterEach(() => session.clear());

describe('LoginPage', () => {
  it('logs in, keeping the access token in memory only', async () => {
    const { calls } = mockApi({
      'POST /auth/login': () => json(200, { data: { accessToken: 'tok', tokenType: 'Bearer', expiresIn: 900 } }),
      'GET /auth/me': () => json(200, { data: customer }),
    });
    renderApp(<LoginPage />, { path: '/login', route: '/login' });
    await userEvent.type(screen.getByLabelText('Email'), 'jamie@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse battery staple');
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));

    expect(await screen.findByText('Navigated away')).toBeInTheDocument();
    expect(calls[0]!.body).toEqual({ email: 'jamie@example.com', password: 'correct horse battery staple' });
    expect(session.token).toBe('tok');
    expect(JSON.stringify({ ...localStorage })).not.toContain('tok'); // never persisted
  });

  it('asks for a 2FA code when the account has it on', async () => {
    const { calls } = mockApi({
      'POST /auth/login': () => json(200, { data: { mfaRequired: true, mfaToken: 'mfa-token-xyz' } }),
      'POST /auth/2fa/verify': () => json(200, { data: { accessToken: 'tok', tokenType: 'Bearer', expiresIn: 900 } }),
      'GET /auth/me': () => json(200, { data: { ...customer, twoFactorEnabled: true } }),
    });
    renderApp(<LoginPage />, { path: '/login', route: '/login' });
    await userEvent.type(screen.getByLabelText('Email'), 'jamie@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));

    await userEvent.type(await screen.findByLabelText('Code'), '12a3456');
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText('Navigated away')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/auth/2fa/verify')!.body).toEqual({ mfaToken: 'mfa-token-xyz', code: '123456' });
  });

  it('shows the server error for bad credentials', async () => {
    mockApi({
      'POST /auth/login': () => json(401, { error: { code: 'UNAUTHORIZED', message: 'Invalid email or password' } }),
    });
    renderApp(<LoginPage />, { path: '/login', route: '/login' });
    await userEvent.type(screen.getByLabelText('Email'), 'jamie@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password');
  });
});

describe('safeRedirect', () => {
  it('only allows paths on this site', () => {
    expect(safeRedirect('/orders')).toBe('/orders');
    expect(safeRedirect('//evil.example')).toBe('/');
    expect(safeRedirect('https://evil.example')).toBe('/');
    expect(safeRedirect(undefined)).toBe('/');
  });
});
