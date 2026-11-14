import { useEffect, useState } from 'react';
import { api, navigate } from '../../api.js';
import AuthBrand from './AuthBrand.jsx';

export default function Forgot({ scope }) {
  const isPlatform = scope === 'platform';
  const [institution, setInstitution] = useState(null);
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isPlatform) api(`/auth/institution/${encodeURIComponent(scope)}`).then(setInstitution).catch((e) => setError(e.message));
  }, [scope, isPlatform]);

  async function submit(e) {
    e?.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/auth/forgot', { method: 'POST', body: { institution: isPlatform ? '' : scope, email } });
      setSent(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center">
      <div className="auth-col">
        <a className="link back" href={`/${scope}`} onClick={(e) => { e.preventDefault(); navigate(`/${scope}`); }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
          Back to log in
        </a>
        <AuthBrand scope={scope} institution={institution} compact />

        {!sent ? (
          <form className="card stack-sm" onSubmit={submit}>
            <h1 className="h2">Forgot your password?</h1>
            <p className="muted">Enter your {isPlatform ? '' : 'work '}email and we'll send you a link to choose a new one.</p>
            <label>
              {isPlatform ? 'Email' : 'Work email'}
              <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </label>
            {error && <div className="alert error">{error}</div>}
            <button className="primary big" disabled={busy}>
              {busy ? 'Sending…' : 'Email me a reset link'}
            </button>
          </form>
        ) : (
          <div className="card stack-sm center-text">
            <span className="circle-icon" aria-hidden="true">
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></svg>
            </span>
            <h1 className="h2">Check your email</h1>
            <p className="muted">
              If an account exists for <strong className="text">{email}</strong>, a reset link is on its way. It works once and expires soon, so use it
              right away.
            </p>
            {error && <div className="alert error">{error}</div>}
            <button onClick={() => submit()} disabled={busy}>
              Didn't get it? Send again
            </button>
          </div>
        )}
        <p className="muted small">The message is the same whether or not the email is registered, so nobody can use this page to find out who has an account.</p>
      </div>
    </div>
  );
}
