import { useCallback, useEffect, useState } from 'react';
import { api, getPosition, formatTime, formatDate, DAY_NAMES } from '../api.js';
import { StatusBadges } from './EmployeeView.jsx';

export default function AdminView({ me }) {
  const [tab, setTab] = useState('attendance');
  return (
    <div className="stack">
      <nav className="subtabs">
        {[
          ['attendance', 'Attendance'],
          ['employees', 'Employees'],
          ['settings', 'Settings'],
        ].map(([key, label]) => (
          <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </nav>
      {tab === 'attendance' && <Attendance me={me} />}
      {tab === 'employees' && <Employees me={me} />}
      {tab === 'settings' && <Settings />}
    </div>
  );
}

// ------------------------------------------------------------------ Attendance

function toCsv(rows, tz) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = ['Date', 'Name', 'Email', 'Check in', 'Late (min)', 'Check out', 'Early (min)', 'Status'];
  const lines = rows.map((r) =>
    [
      r.date,
      r.name,
      r.email,
      r.check_in_at ? formatTime(r.check_in_at, tz) : '',
      r.late_minutes || 0,
      r.check_out_at ? formatTime(r.check_out_at, tz) : '',
      r.early_minutes || 0,
      !r.check_in_at ? 'Absent' : [r.late ? 'Late' : 'On time', r.early ? 'Left early' : ''].filter(Boolean).join(', '),
    ]
      .map(esc)
      .join(','),
  );
  return [header.map(esc).join(','), ...lines].join('\n');
}

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

  function download() {
    const blob = new Blob([toCsv(rows, tz)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `attendance_${from}_${to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

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
        <button onClick={() => { setFrom(me.todayDate); setTo(me.todayDate); }}>Today</button>
        <button onClick={load}>Refresh</button>
        <button onClick={download} disabled={!rows.length}>
          Export CSV
        </button>
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
                  <td className="hide-sm muted">
                    {r.check_in_distance != null ? `${Math.round(r.check_in_distance)} m` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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

  const load = () => api('/admin/users').then(setUsers);
  useEffect(() => {
    load();
  }, []);

  const run = async (fn, success) => {
    setMsg(null);
    try {
      await fn();
      await load();
      setMsg({ type: 'success', text: success });
      return true;
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
      return false;
    }
  };

  async function add(e) {
    e.preventDefault();
    const ok = await run(() => api('/admin/users', { method: 'POST', body: form }), `${form.name} was added.`);
    if (ok) setForm({ name: '', email: '', password: '', role: 'employee' });
  }

  const update = (u, body, text) => run(() => api(`/admin/users/${u.id}`, { method: 'PATCH', body }), text);

  function resetPassword(u) {
    const password = window.prompt(`New password for ${u.name} (min 6 characters):`);
    if (password) update(u, { password }, `Password for ${u.name} was changed.`);
  }

  return (
    <div className="stack">
      <section className="card">
        <h3>Add employee</h3>
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
            Temporary password
            <input
              type="text"
              minLength={6}
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              required
            />
          </label>
          <label>
            Role
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="employee">Employee</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <button className="primary">Add</button>
        </form>
        {msg && <div className={`alert ${msg.type}`}>{msg.text}</div>}
      </section>

      <section className="card">
        <h3>People ({users.length})</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Status</th>
                <th></th>
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
                      value={u.role}
                      disabled={u.id === me.user.id}
                      onChange={(e) => update(u, { role: e.target.value }, `${u.name} is now ${e.target.value}.`)}
                    >
                      <option value="employee">Employee</option>
                      <option value="admin">Admin</option>
                    </select>
                  </td>
                  <td>{u.active ? <span className="badge green">Active</span> : <span className="badge">Disabled</span>}</td>
                  <td className="actions">
                    <button onClick={() => resetPassword(u)}>Reset password</button>
                    {u.id !== me.user.id && (
                      <button
                        onClick={() =>
                          update(u, { active: !u.active }, `${u.name} was ${u.active ? 'disabled' : 'enabled'}.`)
                        }
                      >
                        {u.active ? 'Disable' : 'Enable'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">
          Only people with the Employee role are included in the daily "not checked in" email.
        </p>
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ Settings

function Settings() {
  const [s, setS] = useState(null);
  const [smtp, setSmtp] = useState(false);
  const [msg, setMsg] = useState(null);
  const [locating, setLocating] = useState(false);

  useEffect(() => {
    api('/admin/settings').then((d) => {
      setS(d.settings);
      setSmtp(d.smtpConfigured);
    });
  }, []);

  if (!s) return <div className="card muted">Loading…</div>;

  const set = (k) => (e) => setS({ ...s, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  async function useMyLocation() {
    setLocating(true);
    setMsg(null);
    try {
      const pos = await getPosition();
      setS({ ...s, officeLat: pos.lat.toFixed(6), officeLng: pos.lng.toFixed(6) });
      setMsg({ type: 'success', text: `Location captured (accuracy ±${Math.round(pos.accuracy)} m). Remember to save.` });
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setLocating(false);
    }
  }

  async function save(e) {
    e.preventDefault();
    setMsg(null);
    try {
      const d = await api('/admin/settings', { method: 'PUT', body: s });
      setS(d.settings);
      setMsg({ type: 'success', text: 'Settings saved.' });
    } catch (err) {
      setMsg({ type: 'error', text: err.message });
    }
  }

  async function testEmail() {
    setMsg(null);
    try {
      const d = await api('/admin/test-email', { method: 'POST' });
      setMsg({ type: smtp ? 'success' : 'warn', text: d.message });
    } catch (err) {
      setMsg({ type: 'error', text: err.message });
    }
  }

  const toggleDay = (d) =>
    setS({ ...s, workDays: s.workDays.includes(d) ? s.workDays.filter((x) => x !== d) : [...s.workDays, d] });

  const hasLocation = s.officeLat !== null && s.officeLat !== '' && s.officeLng !== null && s.officeLng !== '';

  return (
    <form className="stack" onSubmit={save}>
      <section className="card">
        <h3>Office location (geofence)</h3>
        <p className="muted small">
          People can only check in or out when their device reports a position within the radius below. The easiest
          way to set this is to open this page while standing in the office and press "Use my current location".
        </p>
        <div className="grid-form">
          <label>
            Office name
            <input value={s.officeName} onChange={set('officeName')} />
          </label>
          <label>
            Latitude
            <input value={s.officeLat ?? ''} onChange={set('officeLat')} placeholder="e.g. -1.944073" />
          </label>
          <label>
            Longitude
            <input value={s.officeLng ?? ''} onChange={set('officeLng')} placeholder="e.g. 30.061885" />
          </label>
          <label>
            Allowed radius (m)
            <input type="number" min="10" value={s.radiusMeters} onChange={set('radiusMeters')} />
          </label>
          <label>
            Max GPS inaccuracy (m)
            <input type="number" min="5" value={s.maxAccuracyMeters} onChange={set('maxAccuracyMeters')} />
          </label>
        </div>
        <div className="row">
          <button type="button" onClick={useMyLocation} disabled={locating}>
            {locating ? 'Locating…' : '📍 Use my current location'}
          </button>
          {hasLocation && (
            <a
              className="link"
              href={`https://www.google.com/maps?q=${s.officeLat},${s.officeLng}`}
              target="_blank"
              rel="noreferrer"
            >
              View on map ↗
            </a>
          )}
        </div>
      </section>

      <section className="card">
        <h3>Working hours</h3>
        <div className="grid-form">
          <label>
            Start time
            <input type="time" value={s.workStart} onChange={set('workStart')} />
          </label>
          <label>
            End time
            <input type="time" value={s.workEnd} onChange={set('workEnd')} />
          </label>
          <label>
            Grace period (min)
            <input type="number" min="0" value={s.graceMinutes} onChange={set('graceMinutes')} />
          </label>
          <label>
            Timezone
            <input value={s.timezone} onChange={set('timezone')} placeholder="e.g. Africa/Kigali" />
          </label>
        </div>
        <div className="days">
          {DAY_NAMES.map((name, d) => (
            <button
              type="button"
              key={d}
              className={s.workDays.includes(d) ? 'day on' : 'day'}
              onClick={() => toggleDay(d)}
            >
              {name}
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <h3>Email alerts</h3>
        {!smtp && (
          <div className="alert warn">
            SMTP is not configured on the server, so emails are only printed in the server console. Set the SMTP_*
            values in <code>server/.env</code> to send real emails.
          </div>
        )}
        <label>
          Send alerts to (comma-separated)
          <input value={s.alertEmails} onChange={set('alertEmails')} placeholder="manager@company.com, hr@company.com" />
        </label>
        <label className="check">
          <input type="checkbox" checked={s.emailEmployee} onChange={set('emailEmployee')} />
          Also email the employee
        </label>
        <label className="check">
          <input type="checkbox" checked={s.notifyEarlyCheckout} onChange={set('notifyEarlyCheckout')} />
          Alert when someone checks out before the end time
        </label>
        <label className="check">
          <input type="checkbox" checked={s.notifyNoShow} onChange={set('notifyNoShow')} />
          Send a list of people who haven't checked in once the grace period ends
        </label>
        <div className="row">
          <button type="button" onClick={testEmail}>
            Send test email
          </button>
        </div>
      </section>

      {msg && <div className={`alert ${msg.type}`}>{msg.text}</div>}
      <div className="row sticky">
        <button className="primary">Save settings</button>
      </div>
    </form>
  );
}
