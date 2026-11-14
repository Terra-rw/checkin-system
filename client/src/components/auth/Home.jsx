import { useEffect, useState } from 'react';
import { api, navigate, getLastInstitution } from '../../api.js';

/** "/" — sends people to their institution, or asks for its short code. */
export default function Home() {
  const [ready, setReady] = useState(false);
  const [code, setCode] = useState('');

  useEffect(() => {
    const last = getLastInstitution();
    if (last) {
      navigate(`/${last}`);
      return;
    }
    api('/auth/home')
      .then((d) => (d.single ? navigate(`/${d.single}`) : setReady(true)))
      .catch(() => setReady(true));
  }, []);

  if (!ready) return <div className="center muted">Loading…</div>;

  const go = (e) => {
    e.preventDefault();
    const c = code.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    if (c) navigate(`/${c}`);
  };

  return (
    <div className="center">
      <div className="auth-col">
        <div className="auth-brand">
          <span className="logo big">✓</span>
          <div className="auth-name">Check-in</div>
        </div>
        <form className="card stack-sm" onSubmit={go}>
          <h1 className="h2">Find your institution</h1>
          <p className="muted">Enter the short code from your login link. For example, in <strong>{window.location.host}/nga</strong> the code is <strong>nga</strong>.</p>
          <label>
            Institution code
            <input value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="none" autoComplete="organization" required />
          </label>
          <button className="primary big">Continue</button>
        </form>
        <p className="muted small center-text">
          Running the platform? <a href="/platform" onClick={(e) => { e.preventDefault(); navigate('/platform'); }}>Platform owner login</a>
        </p>
      </div>
    </div>
  );
}
