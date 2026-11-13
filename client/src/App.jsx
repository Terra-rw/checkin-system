import { useCallback, useEffect, useState } from 'react';
import { api, getToken, setToken } from './api.js';
import Login from './components/Login.jsx';
import EmployeeView from './components/EmployeeView.jsx';
import AdminView from './components/AdminView.jsx';

export default function App() {
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(Boolean(getToken()));
  const [view, setView] = useState('me');

  const refresh = useCallback(() => api('/me').then(setMe), []);

  useEffect(() => {
    if (!getToken()) return;
    refresh()
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, [refresh]);

  if (loading) return <div className="center muted">Loading…</div>;

  if (!me) {
    return (
      <Login
        onLogin={async (token) => {
          setToken(token);
          await refresh();
        }}
      />
    );
  }

  const isAdmin = me.user.role === 'admin';
  const logout = () => {
    setToken(null);
    setMe(null);
    setView('me');
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">✓</span> Check-in
        </div>
        {isAdmin && (
          <nav className="tabs">
            <button className={view === 'me' ? 'active' : ''} onClick={() => setView('me')}>
              My day
            </button>
            <button className={view === 'admin' ? 'active' : ''} onClick={() => setView('admin')}>
              Admin
            </button>
          </nav>
        )}
        <div className="user">
          <span className="muted hide-sm">{me.user.name}</span>
          <button className="link" onClick={logout}>
            Log out
          </button>
        </div>
      </header>
      <main>
        {view === 'admin' && isAdmin ? <AdminView me={me} /> : <EmployeeView me={me} onChange={refresh} />}
      </main>
    </div>
  );
}
