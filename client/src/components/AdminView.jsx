import { useCallback, useEffect, useState } from 'react';
import { api, formatTime, formatDate } from '../api.js';
import { StatusBadges } from './EmployeeView.jsx';
import Reports from './admin/Reports.jsx';
import Settings from './admin/Settings.jsx';
import Security from './admin/Security.jsx';
import Branding from './admin/Branding.jsx';

export default function AdminView({ me, tab, onBrandingSaved }) {
  const [settingsTab, setSettingsTab] = useState('general');
  if (tab === 'reports') return <Reports me={me} />;
  if (tab === 'employees') return <Employees me={me} />;
  if (tab === 'settings') {
    return (
      <div className="stack">
        <nav className="subtabs" aria-label="Settings sections">
          {[
            ['general', 'Office, hours & alerts'],
            ['branding', 'Branding'],
            ['security', 'Security & devices'],
          ].map(([key, label]) => (
            <button key={key} className={settingsTab === key ? 'active' : ''} aria-current={settingsTab === key ? 'page' : undefined} onClick={() => setSettingsTab(key)}>
              {label}
            </button>
          ))}
        </nav>
        {settingsTab === 'general' && <Settings />}
        {settingsTab === 'branding' && <Branding me={me} onSaved={onBrandingSaved} />}
        {settingsTab === 'security' && <Security me={me} />}
      </div>
    );
  }
  return <Attendance me={me} />;
}

// ------------------------------------------------------------------ Attendance

function Attendance({ me }) {
  const tz = me.settings.timezone;
  const [from, setFrom] = useState(me.todayDate);
  const [to, setTo] = useState(me.todayDate);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setError('');
    api(`/admin/attendance?from=${from}&to=${to}`).then(setData).catch((e) => setError(e.message));
  }, [from, to]);

  useEffect(() => {
    load();
  }, [load]);

  const rows = data?.rows || [];
  const single = data && data.from === data.to;
  const present = rows.filter((r) => r.check_in_at);
  const stats = single && {
    total: rows.length,
    present: present.length,
    late: present.filter((r) => r.late).length,
    absent: rows.length - present.length,
    out: present.filter((r) => r.check_out_at).length,
  };

  return (
    <section className="card">
      <div className="toolbar">
        <label>
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          To
          <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button
          onClick={() => {
            setFrom(me.todayDate);
            setTo(me.todayDate);
          }}
        >
          Today
        </button>
        <button onClick={load}>Refresh</button>
      </div>

      {error && <div className="alert error">{error}</div>}

      {stats && (
        <div className="stats">
          <Stat label="Present" value={`${stats.present}/${stats.total}`} />
          <Stat label="Late" value={stats.late} tone={stats.late ? 'amber' : ''} />
          <Stat label="Absent" value={stats.absent} tone={stats.absent ? 'red' : ''} />
          <Stat label="Checked out" value={stats.out} />
        </div>
      )}

      {data && rows.length === 0 ? (
        <p className="muted">No records in this range.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {!single && <th>Date</th>}
                <th>Name</th>
                <th>In</th>
                <th>Out</th>
                <th>Status</th>
                <th className="hide-sm">Distance</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.user_id}-${r.date}`}>
                  {!single && <td>{formatDate(r.date)}</td>}
                  <td>
                    {r.name}
                    <div className="muted small">{r.email}</div>
                  </td>
                  <td>{formatTime(r.check_in_at, tz)}</td>
                  <td>{formatTime(r.check_out_at, tz)}</td>
                  <td>
                    <StatusBadges r={r} />
                  </td>
                  <td className="hide-sm muted">{r.check_in_distance != null ? `${Math.round(r.check_in_distance)} m` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">To download or print attendance, use the Reports tab.</p>
    </section>
  );
}

function Stat({ label, value, tone = '' }) {
  return (
    <div className={`stat ${tone}`}>
      <div className="value">{value}</div>
      <div className="label">{label}</div>
    </div>
  );
}

// ------------------------------------------------------------------ Employees

function Employees({ me }) {
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'employee' });
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => api('/admin/users').then(setUsers);
  useEffect(() => {
    load();
  }, []);

  const run = async (fn, success) => {
    setMsg(null);
    try {
      const result = await fn();
      await load();
      setMsg({ type: 'success', text: result?.message || success });
      return true;
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
      return false;
    }
  };

  async function add(e) {
    e.preventDefault();
    setBusy(true);
    const ok = await run(() => api('/admin/users', { method: 'POST', body: form }), `${form.name} was added.`);
    if (ok) setForm({ name: '', email: '', password: '', role: 'employee' });
    setBusy(false);
  }

  const update = (u, body, text) => run(() => api(`/admin/users/${u.id}`, { method: 'PATCH', body }), text);

  return (
    <div className="stack">
      <section className="card">
        <h2 className="h3">Add employee</h2>
        <form className="grid-form" onSubmit={add}>
          <label>
            Name
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </label>
          <label>
            Email
            <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
          </label>
          <label>
            Temporary password (optional)
            <input type="text" minLength={8} value={form.password} placeholder="Leave empty to email an invite" onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </label>
          <label>
            Role
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="employee">Employee</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <button className="primary" disabled={busy}>
            {form.password ? 'Add' : 'Add & invite'}
          </button>
        </form>
        <p className="muted small">With no password, they get an email with a link to choose their own. That's safer than sharing a temporary one.</p>
        {msg && <div className={`alert ${msg.type}`}>{msg.text}</div>}
      </section>

      <section className="card">
        <h2 className="h3">People ({users.length})</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Status</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className={u.active ? '' : 'dim'}>
                  <td>
                    {u.name}
                    <div className="muted small">{u.email}</div>
                  </td>
                  <td>
                    <select
                      aria-label={`Role for ${u.name}`}
                      value={u.role}
                      disabled={u.id === me.user.id}
                      onChange={(e) => update(u, { role: e.target.value }, `${u.name} is now ${e.target.value}.`)}
                    >
                      <option value="employee">Employee</option>
                      <option value="admin">Admin</option>
                    </select>
                  </td>
                  <td>
                    {!u.active ? (
                      <span className="badge">Disabled</span>
                    ) : u.invitePending ? (
                      <span className="badge amber">Invite pending</span>
                    ) : (
                      <span className="badge green">Active</span>
                    )}
                  </td>
                  <td className="actions">
                    {u.active && (
                      <button onClick={() => run(() => api(`/admin/users/${u.id}/invite`, { method: 'POST' }))}>
                        {u.invitePending ? 'Resend invite' : 'Send reset link'}
                      </button>
                    )}
                    {u.id !== me.user.id && (
                      <button onClick={() => update(u, { active: !u.active }, `${u.name} was ${u.active ? 'disabled' : 'enabled'}.`)}>
                        {u.active ? 'Disable' : 'Enable'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">Only people with the Employee role are included in the daily "not checked in" email.</p>
      </section>
    </div>
  );
}
