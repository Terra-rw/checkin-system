// HR: people, roles, who reports to whom, and each person's contract (with history).
import { useEffect, useMemo, useState } from 'react';
import { api, formatDate, DAY_NAMES } from '../../api.js';
import { Modal, useRunner, Msg } from '../ui.jsx';

const ROLE_LABEL = { employee: 'Employee', manager: 'Manager', admin: 'HR admin' };
const WEEK = [1, 2, 3, 4, 5, 6, 0];

export default function Employees({ me }) {
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'employee', managerId: '' });
  const [editing, setEditing] = useState(null);
  const [filter, setFilter] = useState('');
  const load = () => api('/admin/users').then(setUsers);
  const { msg, busy, run } = useRunner(load);
  useEffect(() => {
    load();
  }, []);

  const managers = users.filter((u) => u.active && (u.role === 'manager' || u.role === 'admin'));
  const names = useMemo(() => new Map(users.map((u) => [u.id, u.name])), [users]);
  const shown = users.filter((u) => !filter || `${u.name} ${u.email}`.toLowerCase().includes(filter.toLowerCase()));

  async function add(e) {
    e.preventDefault();
    const ok = await run(() => api('/admin/users', { method: 'POST', body: { ...form, managerId: form.managerId ? Number(form.managerId) : null } }), `${form.name} was added.`);
    if (ok) setForm({ name: '', email: '', password: '', role: 'employee', managerId: form.managerId });
  }

  return (
    <div className="stack">
      <section className="card">
        <h2 className="h3">Add someone</h2>
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
              {Object.entries(ROLE_LABEL).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label>
            Reports to
            <select value={form.managerId} onChange={(e) => setForm({ ...form, managerId: e.target.value })}>
              <option value="">Nobody (HR handles it)</option>
              {managers.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <button className="primary" disabled={busy}>
            {form.password ? 'Add' : 'Add & invite'}
          </button>
        </form>
        <p className="muted small">With no password, they get an email with a link to choose their own. New people are full-time on the institution's hours until you change their contract.</p>
        <Msg msg={msg} />
      </section>

      <section className="card">
        <div className="section-head">
          <h2 className="h3 no-margin">People ({users.length})</h2>
          <input className="search" type="search" placeholder="Search by name or email" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Search people" />
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th className="hide-sm">Reports to</th>
                <th>Contract</th>
                <th>Status</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((u) => (
                <tr key={u.id} className={u.active ? '' : 'dim'}>
                  <td>
                    {u.name}
                    <div className="muted small">{u.email}</div>
                  </td>
                  <td>{ROLE_LABEL[u.role] || u.role}</td>
                  <td className="hide-sm">{names.get(u.managerId) || <span className="muted">—</span>}</td>
                  <td>
                    <span className={`badge ${u.partTime ? 'blue' : ''}`}>{u.contract}</span>
                  </td>
                  <td>
                    {!u.active ? <span className="badge">Disabled</span> : u.invitePending ? <span className="badge amber">Invite pending</span> : <span className="badge green">Active</span>}
                  </td>
                  <td className="actions">
                    <button className="primary" onClick={() => setEditing(u)}>
                      Edit
                    </button>
                    {u.active && <button onClick={() => run(() => api(`/admin/users/${u.id}/invite`, { method: 'POST' }))}>{u.invitePending ? 'Resend invite' : 'Send reset link'}</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">The daily “not checked in” email only lists people who were expected: days off, approved time off and holidays are left out.</p>
      </section>
      {editing && <EditPerson me={me} user={editing} managers={managers} onClose={() => setEditing(null)} onSaved={load} />}
    </div>
  );
}

/** Turn the latest saved terms into editor state. */
function editorFrom(terms, settings, today) {
  const base = { effectiveFrom: today, employmentType: 'full_time', mode: 'institution', days: [...settings.workDays], times: {}, contractHours: 20, contractPeriod: 'week' };
  if (!terms) return base;
  const days = terms.schedule ? Object.keys(terms.schedule).map(Number) : [...settings.workDays];
  const times = {};
  if (terms.schedule) for (const [d, t] of Object.entries(terms.schedule)) if (t) times[d] = t;
  if (terms.employmentType === 'full_time') return { ...base, mode: terms.schedule ? 'custom' : 'institution', days };
  return {
    ...base,
    employmentType: 'part_time',
    mode: terms.schedule ? 'fixed' : 'flexible',
    days,
    times,
    contractHours: Math.round((terms.contractMinutes / 60) * 10) / 10,
    contractPeriod: terms.contractPeriod,
  };
}

function EditPerson({ me, user, managers, onClose, onSaved }) {
  const s = me.settings;
  const [role, setRole] = useState(user.role);
  const [managerId, setManagerId] = useState(user.managerId ? String(user.managerId) : '');
  const [terms, setTerms] = useState(null);
  const [c, setC] = useState(null);
  const [tab, setTab] = useState('details');
  const people = useRunner(onSaved);
  const contract = useRunner(async () => {
    await onSaved();
    await loadTerms();
  });
  const self = user.id === me.user.id;

  const loadTerms = () =>
    api(`/admin/users/${user.id}/terms`).then((rows) => {
      setTerms(rows);
      const current = rows.find((t) => t.effectiveFrom <= me.todayDate) || rows[rows.length - 1];
      setC(editorFrom(current, s, me.todayDate));
    });
  useEffect(() => {
    loadTerms();
  }, [user.id]);

  const saveDetails = (e) => {
    e.preventDefault();
    const body = {};
    if (role !== user.role) body.role = role;
    if ((managerId || null) !== (user.managerId ? String(user.managerId) : null)) body.managerId = managerId ? Number(managerId) : null;
    if (!Object.keys(body).length) return people.setMsg({ type: 'success', text: 'Nothing to change.' });
    people.run(() => api(`/admin/users/${user.id}`, { method: 'PATCH', body }), `${user.name} updated.`);
  };

  const saveContract = (e) => {
    e.preventDefault();
    contract.run(() => api(`/admin/users/${user.id}/terms`, { method: 'PUT', body: c }));
  };

  const toggleDay = (d) => {
    const on = c.days.includes(d);
    const times = { ...c.times };
    if (!on && !times[d]) times[d] = [s.workStart, s.workEnd];
    setC({ ...c, days: on ? c.days.filter((x) => x !== d) : [...c.days, d].sort(), times });
  };

  const weeklyFixed =
    c?.mode === 'fixed'
      ? c.days.reduce((n, d) => {
          const [a, b] = c.times[d] || [];
          if (!a || !b) return n;
          const m = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
          return n + Math.max(0, m(b) - m(a));
        }, 0)
      : 0;

  return (
    <Modal title={user.name} onClose={onClose} wide>
      <nav className="subtabs" aria-label="Edit sections">
        {[
          ['details', 'Role & manager'],
          ['contract', 'Contract & working days'],
        ].map(([k, l]) => (
          <button key={k} className={tab === k ? 'active' : ''} aria-current={tab === k ? 'page' : undefined} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </nav>

      {tab === 'details' && (
        <form className="stack-sm" onSubmit={saveDetails}>
          <div className="grid-form">
            <label>
              Role
              <select value={role} onChange={(e) => setRole(e.target.value)} disabled={self}>
                {Object.entries(ROLE_LABEL).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Reports to
              <select value={managerId} onChange={(e) => setManagerId(e.target.value)}>
                <option value="">Nobody (HR handles it)</option>
                {managers
                  .filter((m) => m.id !== user.id)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <p className="muted small no-margin">
            Managers see and approve time off for the people who report to them, fix their check-in times and run their reports. Changing someone's role signs them out
            everywhere.
          </p>
          <div className="row">
            <button className="primary" disabled={people.busy}>
              Save
            </button>
            {!self && (
              <button
                type="button"
                className={user.active ? 'danger' : ''}
                onClick={() => people.run(() => api(`/admin/users/${user.id}`, { method: 'PATCH', body: { active: !user.active } }), `${user.name} was ${user.active ? 'disabled' : 'enabled'}.`).then((ok) => ok && onClose())}
              >
                {user.active ? 'Disable account' : 'Enable account'}
              </button>
            )}
          </div>
          <Msg msg={people.msg} />
        </form>
      )}

      {tab === 'contract' && !c && <p className="muted">Loading…</p>}
      {tab === 'contract' && c && (
        <form className="stack-sm" onSubmit={saveContract}>
          <div className="seg" role="radiogroup" aria-label="Employment type">
            {[
              ['full_time', 'Full-time'],
              ['part_time', 'Part-time'],
            ].map(([k, l]) => (
              <button
                type="button"
                key={k}
                role="radio"
                aria-checked={c.employmentType === k}
                className={c.employmentType === k ? 'on' : ''}
                onClick={() => setC({ ...c, employmentType: k, mode: k === 'full_time' ? 'institution' : 'flexible' })}
              >
                {l}
              </button>
            ))}
          </div>

          {c.employmentType === 'full_time' ? (
            <fieldset className="plain stack-sm">
              <legend className="muted small">Working days</legend>
              <label className="inline-label">
                <input type="radio" checked={c.mode === 'institution'} onChange={() => setC({ ...c, mode: 'institution', days: [...s.workDays] })} /> Institution days and hours ({s.workDays.map((d) => DAY_NAMES[d]).join(', ')}, {s.workStart}–{s.workEnd})
              </label>
              <label className="inline-label">
                <input type="radio" checked={c.mode === 'custom'} onChange={() => setC({ ...c, mode: 'custom' })} /> Custom days (e.g. a negotiated day off), institution hours
              </label>
              {c.mode === 'custom' && (
                <div className="days">
                  {WEEK.map((d) => (
                    <button type="button" key={d} className={c.days.includes(d) ? 'day on' : 'day'} aria-pressed={c.days.includes(d)} onClick={() => toggleDay(d)}>
                      {DAY_NAMES[d]}
                    </button>
                  ))}
                </div>
              )}
            </fieldset>
          ) : (
            <>
              <div className="grid-form">
                <label>
                  Contracted hours
                  <input type="number" min={1} max={c.contractPeriod === 'week' ? 60 : 260} step="0.5" value={c.contractHours} onChange={(e) => setC({ ...c, contractHours: e.target.value })} required />
                </label>
                <label>
                  Per
                  <select value={c.contractPeriod} onChange={(e) => setC({ ...c, contractPeriod: e.target.value })}>
                    <option value="week">Week</option>
                    <option value="month">Month</option>
                  </select>
                </label>
              </div>
              <fieldset className="plain stack-sm">
                <legend className="muted small">When they work</legend>
                <label className="inline-label">
                  <input type="radio" checked={c.mode === 'flexible'} onChange={() => setC({ ...c, mode: 'flexible' })} /> Flexible: any time; only total hours are tracked (never marked late or absent)
                </label>
                <label className="inline-label">
                  <input type="radio" checked={c.mode === 'fixed'} onChange={() => setC({ ...c, mode: 'fixed' })} /> Fixed days and times (late and absent apply on those days)
                </label>
              </fieldset>
              {c.mode === 'fixed' && (
                <div className="schedule">
                  {WEEK.map((d) => {
                    const on = c.days.includes(d);
                    const [a, b] = c.times[d] || [s.workStart, s.workEnd];
                    return (
                      <div key={d} className={`schedule-row ${on ? '' : 'off'}`}>
                        <label className="inline-label">
                          <input type="checkbox" checked={on} onChange={() => toggleDay(d)} /> {DAY_NAMES[d]}
                        </label>
                        {on ? (
                          <>
                            <input type="time" aria-label={`${DAY_NAMES[d]} start`} value={a} onChange={(e) => setC({ ...c, times: { ...c.times, [d]: [e.target.value, b] } })} required />
                            <span className="muted">to</span>
                            <input type="time" aria-label={`${DAY_NAMES[d]} end`} value={b} onChange={(e) => setC({ ...c, times: { ...c.times, [d]: [a, e.target.value] } })} required />
                          </>
                        ) : (
                          <span className="muted small">Not scheduled</span>
                        )}
                      </div>
                    );
                  })}
                  {c.contractPeriod === 'week' && weeklyFixed > 0 && Math.abs(weeklyFixed / 60 - Number(c.contractHours)) > 0.01 && (
                    <p className="muted small no-margin">
                      These times add up to {Math.round((weeklyFixed / 60) * 10) / 10} hr a week; the contract says {c.contractHours} hr. The hours report compares against the contract.
                    </p>
                  )}
                </div>
              )}
            </>
          )}

          <div className="grid-form">
            <label>
              Starts on
              <input type="date" value={c.effectiveFrom} onChange={(e) => setC({ ...c, effectiveFrom: e.target.value })} required />
            </label>
          </div>
          <p className="muted small no-margin">Days before this date keep the previous contract, so past reports don't change.</p>
          <div className="row">
            <button className="primary" disabled={contract.busy}>
              Save contract
            </button>
          </div>
          <Msg msg={contract.msg} />

          {terms?.length > 0 && (
            <details>
              <summary className="muted small">Contract history ({terms.length})</summary>
              <ul className="events">
                {terms.map((t) => (
                  <li key={t.id}>
                    From {formatDate(t.effectiveFrom)}:{' '}
                    {t.employmentType === 'part_time'
                      ? `Part-time, ${Math.round((t.contractMinutes / 60) * 10) / 10} hr/${t.contractPeriod}, ${t.schedule ? 'fixed days' : 'flexible'}`
                      : t.schedule
                        ? `Full-time, ${Object.keys(t.schedule)
                            .map((d) => DAY_NAMES[d])
                            .join(', ')}`
                        : 'Full-time, institution days'}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </form>
      )}
    </Modal>
  );
}
