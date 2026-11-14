import { useEffect, useMemo, useState } from 'react';
import { api, navigate, setSession, initials } from '../api.js';

const TINTS = ['#0f766e', '#1d4ed8', '#7c3aed', '#b45309', '#be185d', '#0369a1'];

function timeZones() {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['UTC', 'Africa/Kigali', 'Africa/Nairobi', 'Africa/Johannesburg', 'Europe/London'];
  }
}

const emptyForm = () => ({
  name: '',
  code: '',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  adminName: '',
  adminEmail: '',
});

export default function PlatformView() {
  const [list, setList] = useState(null);
  const [query, setQuery] = useState('');
  const [form, setForm] = useState(emptyForm);
  const [codeTouched, setCodeTouched] = useState(false);
  const [msg, setMsg] = useState(null);
  const [rowMsg, setRowMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const zones = useMemo(timeZones, []);

  const load = () => api('/platform/institutions').then(setList);
  useEffect(() => {
    load().catch((e) => setRowMsg({ type: 'error', text: e.message }));
  }, []);

  const slug = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

  async function create(e) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const d = await api('/platform/institutions', { method: 'POST', body: form });
      setMsg({ type: 'success', text: d.message });
      setForm(emptyForm());
      setCodeTouched(false);
      await load();
    } catch (err) {
      setMsg({ type: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function rowAction(fn) {
    setRowMsg(null);
    try {
      const text = await fn();
      await load();
      if (text) setRowMsg({ type: 'success', text });
    } catch (err) {
      setRowMsg({ type: 'error', text: err.message });
    }
  }

  async function open(inst) {
    try {
      const d = await api(`/platform/institutions/${inst.id}/support`, { method: 'POST' });
      setSession(inst.code, { token: d.token, support: true });
      navigate(`/${inst.code}`);
    } catch (err) {
      setRowMsg({ type: 'error', text: err.message });
    }
  }

  const shown = (list || []).filter((i) => `${i.name} ${i.code}`.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="stack">
      <div>
        <h1 className="h1">Institutions</h1>
        <p className="muted">
          Each institution has its own employees, offices, schedule, email alerts and reports. Nothing is shared between them.
        </p>
      </div>

      <div className="split">
        <section className="card split-main" aria-labelledby="inst-list">
          <div className="section-head">
            <h2 id="inst-list" className="h3">
              All institutions {list ? `(${list.length})` : ''}
            </h2>
            <label className="inline-label">
              Search
              <input type="search" placeholder="Name or code" value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
          </div>
          {rowMsg && <div className={`alert ${rowMsg.type}`}>{rowMsg.text}</div>}
          {list && list.length === 0 ? (
            <p className="muted">No institutions yet. Create the first one with the form.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Institution</th>
                    <th>Login link</th>
                    <th className="num">People</th>
                    <th>Status</th>
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((i) => {
                    const suspended = i.status === 'suspended';
                    return (
                      <tr key={i.id}>
                        <td>
                          <div className="who">
                            <span className="avatar" style={{ background: TINTS[i.id % TINTS.length] }}>
                              {initials(i.name)}
                            </span>
                            <div>
                              <div className="strong">{i.name}</div>
                              <div className="muted small">{i.timezone}</div>
                            </div>
                          </div>
                        </td>
                        <td>
                          <a href={`/${i.code}`}>
                            {window.location.host}/{i.code}
                          </a>
                        </td>
                        <td className="num">{i.people}</td>
                        <td>
                          {suspended ? (
                            <span className="badge">Suspended</span>
                          ) : i.invitePending ? (
                            <span className="badge amber">Invite pending</span>
                          ) : (
                            <span className="badge green">Active</span>
                          )}
                        </td>
                        <td className="actions">
                          {!suspended && <button onClick={() => open(i)}>Open</button>}
                          {!suspended && i.invitePending && (
                            <button onClick={() => rowAction(async () => (await api(`/platform/institutions/${i.id}/invite`, { method: 'POST' })).message)}>
                              Resend invite
                            </button>
                          )}
                          <button
                            onClick={() => {
                              if (!suspended && !window.confirm(`Suspend ${i.name}? Nobody there will be able to log in or check in until you reactivate it.`)) return;
                              rowAction(async () => {
                                await api(`/platform/institutions/${i.id}`, { method: 'PATCH', body: { status: suspended ? 'active' : 'suspended' } });
                                return `${i.name} was ${suspended ? 'reactivated' : 'suspended'}.`;
                              });
                            }}
                          >
                            {suspended ? 'Reactivate' : 'Suspend'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted small">
            "Open" lets you view an institution as its admin, for support. Every time you do, it's recorded in that institution's security log.
          </p>
        </section>

        <form className="card split-side stack-sm" onSubmit={create} aria-labelledby="new-inst">
          <h2 id="new-inst" className="h3">
            New institution
          </h2>
          <label>
            Institution name
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value, code: codeTouched ? form.code : slug(e.target.value) })}
              required
            />
          </label>
          <label>
            Short code (used in the login link)
            <div className="input-prefix">
              <span>{window.location.host}/</span>
              <input
                value={form.code}
                onChange={(e) => {
                  setCodeTouched(true);
                  setForm({ ...form, code: slug(e.target.value) });
                }}
                required
                minLength={2}
              />
            </div>
          </label>
          <label>
            Timezone
            <select value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
              {!zones.includes(form.timezone) && <option>{form.timezone}</option>}
              {zones.map((z) => (
                <option key={z}>{z}</option>
              ))}
            </select>
          </label>
          <hr />
          <div className="strong small">First admin</div>
          <label>
            Full name
            <input value={form.adminName} onChange={(e) => setForm({ ...form, adminName: e.target.value })} required />
          </label>
          <label>
            Email
            <input type="email" value={form.adminEmail} onChange={(e) => setForm({ ...form, adminEmail: e.target.value })} required />
          </label>
          <p className="muted small">They get an email with a link to set their own password. You never see or choose it.</p>
          {msg && <div className={`alert ${msg.type}`}>{msg.text}</div>}
          <button className="primary big" disabled={busy}>
            {busy ? 'Creating…' : 'Create institution & send invite'}
          </button>
        </form>
      </div>
    </div>
  );
}
