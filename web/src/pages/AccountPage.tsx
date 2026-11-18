import QRCode from 'qrcode';
import { useEffect, useState, type FormEvent } from 'react';
import { authApi } from '../api/endpoints';
import { useAuth } from '../auth/AuthProvider';
import { Alert, ErrorAlert } from '../components/Alert';
import { formatDate } from '../lib/format';

export function AccountPage() {
  const { user } = useAuth();
  if (!user) return null;
  return (
    <section className="stack">
      <h1>Account</h1>
      <div className="panel">
        <dl className="facts">
          <dt>Email</dt>
          <dd>{user.email}</dd>
          <dt>Account type</dt>
          <dd className="capitalize">{user.role}</dd>
          <dt>Member since</dt>
          <dd>{formatDate(user.createdAt)}</dd>
        </dl>
      </div>
      <TwoFactor />
    </section>
  );
}

function TwoFactor() {
  const { user, adopt, reloadUser } = useAuth();
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The QR code is drawn in the browser: the secret never goes to a third-party QR service.
  useEffect(() => {
    if (!setup) return;
    let live = true;
    QRCode.toDataURL(setup.otpauthUri, { margin: 1, width: 200 }).then(
      (url) => live && setQr(url),
      () => live && setQr(null),
    );
    return () => {
      live = false;
    };
  }, [setup]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const start = () => run(async () => setSetup(await authApi.setupTotp()));

  const enable = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      // Enabling 2FA signs out every other session and hands this one new tokens.
      await adopt(await authApi.enableTotp(code));
      setSetup(null);
      setCode('');
      setNotice('Two-factor authentication is on. Other devices were signed out.');
    });
  };

  const disable = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await authApi.disableTotp(code);
      await reloadUser();
      setCode('');
      setNotice('Two-factor authentication is off.');
    });
  };

  const codeInput = (
    <label>
      6-digit code
      <input
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="\d{6}"
        maxLength={6}
        required
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
      />
    </label>
  );

  return (
    <div className="panel">
      <h2>Two-factor authentication</h2>
      {notice && <Alert kind="success">{notice}</Alert>}
      {user?.twoFactorEnabled ? (
        <>
          <p>
            <span className="status status-placed">On</span> Logging in asks for a code from your authenticator app.
          </p>
          <form className="form inline-form" onSubmit={disable}>
            {codeInput}
            <button className="button secondary" disabled={busy || code.length !== 6}>
              Turn off
            </button>
          </form>
        </>
      ) : setup ? (
        <>
          <ol className="steps">
            <li>Scan this QR code with an authenticator app (Google Authenticator, 1Password, Authy…).</li>
            <li>Enter the 6-digit code it shows to confirm.</li>
          </ol>
          {qr && <img className="qr" src={qr} width={200} height={200} alt="QR code for your authenticator app" />}
          <details>
            <summary>Can't scan? Enter this key instead</summary>
            <code className="secret">{setup.secret}</code>
          </details>
          <form className="form inline-form" onSubmit={enable}>
            {codeInput}
            <button className="button" disabled={busy || code.length !== 6}>
              Turn on
            </button>
          </form>
        </>
      ) : (
        <>
          <p>Add a second step to logging in, so a stolen password alone isn't enough.</p>
          <button type="button" className="button" onClick={() => void start()} disabled={busy}>
            Set up two-factor authentication
          </button>
        </>
      )}
      <ErrorAlert error={error} />
    </div>
  );
}
