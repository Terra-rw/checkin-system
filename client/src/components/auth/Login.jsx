import { useEffect, useState } from 'react';
import { api, navigate, getDeviceToken, setDeviceToken, setLastInstitution } from '../../api.js';
import AuthBrand, { AuthPage } from './AuthBrand.jsx';

export default function Login({ scope, institution, onLoggedIn }) {
  const isPlatform = scope === 'platform';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [challenge, setChallenge] = useState(null);

  async function finish(data) {
    if (data.deviceToken) setDeviceToken(scope, email, data.deviceToken);
    if (!isPlatform) setLastInstitution(scope);
    await onLoggedIn({ token: data.token });
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const data = await api('/auth/login', {
        method: 'POST',
        body: { institution: isPlatform ? '' : scope, email, password, deviceToken: getDeviceToken(scope, email) },
      });
      if (data.challenge) {
        setChallenge(data);
        setBusy(false);
      } else {
        await finish(data);
      }
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  if (challenge) {
    return <VerifyCode scope={scope} institution={institution} challenge={challenge} onBack={() => setChallenge(null)} onDone={finish} />;
  }

  return (
    <AuthPage institution={institution}>
      <div className="auth-col">
        <AuthBrand scope={scope} institution={institution} />
        <form className="card stack-sm" onSubmit={submit}>
          <h1 className="h2">{isPlatform ? 'Platform owner login' : 'Log in to check in'}</h1>
          <label>
            {isPlatform ? 'Email' : 'Work email'}
            <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label>
            Password
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          <a
            className="link align-end"
            href={`/${scope}/forgot`}
            onClick={(e) => {
              e.preventDefault();
              navigate(`/${scope}/forgot`);
            }}
          >
            Forgot password?
          </a>
          {error && <div className="alert error">{error}</div>}
          <button className="primary big" disabled={busy}>
            {busy ? 'Logging in…' : 'Log in'}
          </button>
        </form>
        <div className="note">
          <LockIcon />
          <span>The first time you log in on a phone or computer, we'll email you a 6-digit code to confirm it's you.</span>
        </div>
        {!isPlatform && (
          <p className="muted small center-text">
            Not with {institution?.name}?{' '}
            <a href="/" onClick={(e) => { e.preventDefault(); navigate('/'); }}>
              Choose your institution
            </a>
          </p>
        )}
      </div>
    </AuthPage>
  );
}

function VerifyCode({ scope, institution, challenge, onBack, onDone }) {
  const [code, setCode] = useState('');
  const [trust, setTrust] = useState(true);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(challenge.resendSeconds);

  useEffect(() => {
    if (wait <= 0) return undefined;
    const id = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(id);
  }, [wait]);

  async function verify(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setInfo('');
    try {
      const data = await api('/auth/verify', { method: 'POST', body: { challenge: challenge.challenge, code, trust } });
      await onDone(data);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  async function resend() {
    setError('');
    try {
      const d = await api('/auth/resend', { method: 'POST', body: { challenge: challenge.challenge } });
      setInfo(d.message);
      setWait(d.resendSeconds);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <AuthPage institution={institution}>
      <div className="auth-col">
        <AuthBrand scope={scope} institution={institution} compact />
        <div className="center-text stack-sm">
          <span className="circle-icon" aria-hidden="true">
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="7" y="2" width="10" height="20" rx="2" /><path d="M11 18h2" /></svg>
          </span>
          <h1 className="h2">Confirm it's you</h1>
          <p className="muted">
            This is your first time logging in on this device. We emailed a 6-digit code to <strong className="text">{challenge.emailHint}</strong>.
          </p>
        </div>
        <form className="card stack-sm" onSubmit={verify}>
          <label>
            6-digit code
            <input
              className="code-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              pattern="\d{6}"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              required
              autoFocus
            />
          </label>
          <div className="muted small center-text">The code expires in {challenge.codeMinutes} min.</div>
          <label className="check">
            <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} />
            <span>
              Trust this device for {challenge.trustDays} days
              <br />
              <span className="muted small">Untick on a shared or borrowed phone.</span>
            </span>
          </label>
          {error && <div className="alert error">{error}</div>}
          {info && <div className="alert success">{info}</div>}
          <button className="primary big" disabled={busy || code.length !== 6}>
            {busy ? 'Checking…' : 'Verify and continue'}
          </button>
          <button type="button" onClick={resend} disabled={wait > 0}>
            {wait > 0 ? `Resend code (in 0:${String(wait).padStart(2, '0')})` : 'Resend code'}
          </button>
        </form>
        <p className="muted small center-text">
          Didn't try to log in? Someone may know your password.{' '}
          <a href={`/${scope}/forgot`} onClick={(e) => { e.preventDefault(); navigate(`/${scope}/forgot`); }}>
            Change it now
          </a>
          .
        </p>
        <button className="link center-self" onClick={onBack}>
          Use a different account
        </button>
      </div>
    </AuthPage>
  );
}

function LockIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none', marginTop: 1 }}>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}
