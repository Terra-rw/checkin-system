import { useEffect, useRef, useState } from 'react';
import { api, navigate, getLastInstitution } from '../../api.js';
import Logo from '../Logo.jsx';

/** "/" — people search for their institution by name or code. */
export default function Home() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null); // null = nothing searched yet
  const [searching, setSearching] = useState(false);
  const [recent, setRecent] = useState(null);
  const latest = useRef(0);

  // Offer (not force) the institution this device used last.
  useEffect(() => {
    const last = getLastInstitution();
    if (last) api(`/auth/institution/${encodeURIComponent(last)}`).then(setRecent).catch(() => {});
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      setSearching(false);
      return undefined;
    }
    setSearching(true);
    const id = ++latest.current;
    const timer = setTimeout(() => {
      api(`/auth/institutions?q=${encodeURIComponent(q)}`)
        .then((rows) => id === latest.current && setResults(rows))
        .catch(() => id === latest.current && setResults([]))
        .finally(() => id === latest.current && setSearching(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const go = (code) => navigate(`/${code}`);

  function submit(e) {
    e.preventDefault();
    if (results?.length === 1) go(results[0].code);
  }

  return (
    <div className="center">
      <div className="auth-col">
        <div className="auth-brand">
          <span className="logo big">✓</span>
          <div className="auth-name">Check-in</div>
        </div>

        {recent && (
          <button className="inst-option recent" onClick={() => go(recent.code)}>
            <Logo inst={recent} size={40} />
            <span className="inst-text">
              <span className="muted small">Continue to</span>
              <span className="strong">{recent.name}</span>
            </span>
            <Chevron />
          </button>
        )}

        <form className="card stack-sm" onSubmit={submit} role="search">
          <h1 className="h2">Find your institution</h1>
          <label>
            Institution name or code
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Start typing, e.g. NGA"
              autoComplete="organization"
              autoFocus={!recent}
              aria-describedby="search-status"
            />
          </label>

          <div id="search-status" className="muted small" aria-live="polite">
            {query.trim().length < 2
              ? 'Type at least 2 letters.'
              : searching
                ? 'Searching…'
                : results && results.length === 0
                  ? 'No institution found. Check the spelling, or ask your administrator for your login link.'
                  : results
                    ? `${results.length} found`
                    : ''}
          </div>

          {results && results.length > 0 && (
            <ul className="inst-list">
              {results.map((r) => (
                <li key={r.code}>
                  <button type="button" className="inst-option" onClick={() => go(r.code)}>
                    <Logo inst={r} size={36} />
                    <span className="inst-text">
                      <span className="strong">{r.name}</span>
                      <span className="muted small">
                        {window.location.host}/{r.code}
                      </span>
                    </span>
                    <Chevron />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </form>

        <p className="muted small center-text">
          Running the platform?{' '}
          <a
            href="/platform"
            onClick={(e) => {
              e.preventDefault();
              navigate('/platform');
            }}
          >
            Platform owner login
          </a>
        </p>
      </div>
    </div>
  );
}

function Chevron() {
  return (
    <svg className="chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}
