import { useEffect, useState } from 'react';
import { api, navigate } from '../../api.js';
import AuthBrand from './AuthBrand.jsx';

const MIN = 8;

/** Handles both password reset links and invite links. */
export default function SetPassword({ scope, token }) {
  const [info, setInfo] = useState(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api(`/auth/link?token=${encodeURIComponent(token || '')}`)
      .then(setInfo)
      .catch(() => setInfo({ valid: false }));
  }, [token]);

  const goLogin = () => navigate(`/${scope}`);

  if (!info) return <div className="center muted">Loading…</div>;

  if (!info.valid) {
    return (
      <div className="center">
        <div className="auth-col">
          <AuthBrand scope={scope} institution={null} compact />
          <div className="card stack-sm">
            <h1 className="h2">This link no longer works</h1>
            <p className="muted">It may have expired or already been used. Request a new one and use it straight away.</p>
            <button className="primary big" onClick={() => navigate(`/${scope}/forgot`)}>
              Request a new link
            </button>
            <button onClick={goLogin}>Back to log in</button>
          </div>
        </div>
      </div>
    );
  }

  const invite = info.kind === 'invite';
  const rules = [
    [password.length >= MIN, `At least ${MIN} characters`],
    [password.length > 0 && password === confirm, 'Both passwords match'],
  ];

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const d = await api('/auth/reset', { method: 'POST', body: { token, password } });
      setDone(d.message);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="center">
        <div className="auth-col">
          <AuthBrand scope={scope} institution={info.institution} compact />
          <div className="card stack-sm center-text">
            <span className="circle-icon ok" aria-hidden="true">✓</span>
            <h1 className="h2">{invite ? "You're all set" : 'Password changed'}</h1>
            <p className="muted">{done}</p>
            <button className="primary big" onClick={goLogin}>
              Go to log in
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="center">
      <div className="auth-col">
        <AuthBrand scope={scope} institution={info.institution} compact />
        <form className="card stack-sm" onSubmit={submit}>
          <h1 className="h2">{invite ? `Welcome, ${info.name.split(' ')[0]}` : 'Choose a new password'}</h1>
          <p className="muted">
            {invite ? 'Choose a password to finish setting up your account ' : 'For '}
            <strong className="text">{info.email}</strong>
          </p>
          <label>
            New password
            <div className="input-with-button">
              <input type={show ? 'text' : 'password'} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              <button type="button" className="link" onClick={() => setShow(!show)} aria-pressed={show}>
                {show ? 'Hide' : 'Show'}
              </button>
            </div>
          </label>
          <label>
            Type it again
            <input type={show ? 'text' : 'password'} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </label>
          <ul className="rules" aria-label="Password rules">
            {rules.map(([ok, text]) => (
              <li key={text} className={ok ? 'ok' : ''}>
                <span className="rule-dot" aria-hidden="true">{ok ? '✓' : ''}</span>
                {text}
                <span className="sr-only">{ok ? ' (done)' : ' (not yet)'}</span>
              </li>
            ))}
          </ul>
          {error && <div className="alert error">{error}</div>}
          <button className="primary big" disabled={busy || !rules.every(([ok]) => ok)}>
            {busy ? 'Saving…' : invite ? 'Set password' : 'Save new password'}
          </button>
        </form>
        {!invite && (
          <p className="muted small">Saving logs you out everywhere else and forgets your trusted devices, so you'll need a new email code on each one.</p>
        )}
      </div>
    </div>
  );
}
