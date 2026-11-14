import { useCallback, useEffect, useState } from 'react';
import { api, getSession, setSession, setScope, parseRoute, navigate, initials } from './api.js';
import Home from './components/auth/Home.jsx';
import Login from './components/auth/Login.jsx';
import Forgot from './components/auth/Forgot.jsx';
import SetPassword from './components/auth/SetPassword.jsx';
import EmployeeView from './components/EmployeeView.jsx';
import AdminView from './components/AdminView.jsx';
import PlatformView from './components/PlatformView.jsx';

export default function App() {
  const [route, setRoute] = useState(parseRoute);

  useEffect(() => {
    const onPop = () => setRoute(parseRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  if (route.page === 'home') return <Home />;
  setScope(route.scope);
  if (route.page === 'forgot') return <Forgot key={route.scope} scope={route.scope} />;
  if (route.page === 'reset') return <SetPassword key={route.token} scope={route.scope} token={route.token} />;
  return <ScopeApp key={route.scope} scope={route.scope} />;
}

/** Everything under /<institution> or /platform once the route is known. */
function ScopeApp({ scope }) {
  const isPlatform = scope === 'platform';
  const [institution, setInstitution] = useState(null);
  const [instError, setInstError] = useState('');
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => api('/me').then(setMe), []);

  useEffect(() => {
    const load = async () => {
      if (!isPlatform) {
        try {
          setInstitution(await api(`/auth/institution/${encodeURIComponent(scope)}`));
        } catch (e) {
          setInstError(e.message);
          setLoading(false);
          return;
        }
      }
      if (getSession(scope)) {
        try {
          await refresh();
        } catch {
          setSession(scope, null);
        }
      }
      setLoading(false);
    };
    load();
  }, [scope, isPlatform, refresh]);

  if (loading) return <div className="center muted">Loading…</div>;

  if (instError) {
    return (
      <div className="center">
        <div className="card narrow stack-sm">
          <h1 className="h2">Institution not available</h1>
          <p className="muted">{instError}</p>
          <button className="primary" onClick={() => navigate('/')}>
            Choose your institution
          </button>
        </div>
      </div>
    );
  }

  if (!me) {
    return (
      <Login
        scope={scope}
        institution={institution}
        onLoggedIn={async (session) => {
          setSession(scope, session);
          await refresh();
        }}
      />
    );
  }

  const logout = () => {
    setSession(scope, null);
    setMe(null);
  };

  if (isPlatform) {
    return (
      <Shell brand={{ initials: '✓', name: 'Check-in', tag: 'Platform' }} user={me.user} onLogout={logout}>
        <PlatformView />
      </Shell>
    );
  }

  return <InstitutionApp scope={scope} me={me} refresh={refresh} onLogout={logout} />;
}

function InstitutionApp({ scope, me, refresh, onLogout }) {
  const isAdmin = me.user.role === 'admin';
  const tabs = isAdmin
    ? [
        ...(me.support ? [] : [['me', 'My day']]),
        ['attendance', 'Attendance'],
        ['reports', 'Reports'],
        ['employees', 'Employees'],
        ['settings', 'Settings'],
      ]
    : [];
  const [view, setView] = useState(tabs[0]?.[0] || 'me');

  const exitSupport = () => {
    setSession(scope, null);
    navigate('/platform');
  };

  return (
    <Shell
      brand={{ initials: initials(me.institution.name), name: me.institution.name }}
      user={me.user}
      tabs={tabs}
      view={view}
      onView={setView}
      onLogout={me.support ? exitSupport : onLogout}
      logoutLabel={me.support ? 'Exit support view' : 'Log out'}
    >
      {me.support && (
        <div className="alert warn banner">
          Support view: you are seeing {me.institution.name} as its admin. Everything you do is recorded in its security log.
        </div>
      )}
      {view === 'me' || !isAdmin ? <EmployeeView me={me} onChange={refresh} /> : <AdminView me={me} tab={view} />}
    </Shell>
  );
}

function Shell({ brand, user, tabs = [], view, onView, onLogout, logoutLabel = 'Log out', children }) {
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">{brand.initials}</span>
          <span className="brand-name">{brand.name}</span>
          {brand.tag && <span className="tag">{brand.tag}</span>}
        </div>
        {tabs.length > 0 && (
          <nav className="tabs" aria-label="Main">
            {tabs.map(([key, label]) => (
              <button key={key} className={view === key ? 'active' : ''} aria-current={view === key ? 'page' : undefined} onClick={() => onView(key)}>
                {label}
              </button>
            ))}
          </nav>
        )}
        <div className="user">
          <span className="muted hide-sm">{user.name}</span>
          <button className="link" onClick={onLogout}>
            {logoutLabel}
          </button>
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}
