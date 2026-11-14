// HR: public holidays and closures (nobody is expected), plus the read-only roles matrix.
import { useEffect, useState } from 'react';
import { api, formatDate } from '../../api.js';
import { useRunner, Msg } from '../ui.jsx';

const dayMonth = (ymd) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

export function Holidays({ me }) {
  const [rows, setRows] = useState(null);
  const blank = { name: '', startDate: me.todayDate, endDate: me.todayDate, kind: 'public', yearly: false };
  const [f, setF] = useState(blank);
  const [showPast, setShowPast] = useState(false);
  const load = () => api('/admin/holidays').then(setRows);
  const { msg, busy, run } = useRunner(load);
  useEffect(() => {
    load();
  }, []);

  // Yearly holidays sort by their next date; one-off ones by their own date.
  const next = (h) => (h.yearly ? (h.startDate.slice(5) >= me.todayDate.slice(5) ? me.todayDate.slice(0, 4) : String(Number(me.todayDate.slice(0, 4)) + 1)) + h.startDate.slice(4) : h.startDate);
  const shown = (rows || []).filter((h) => showPast || !h.past).sort((a, b) => (next(a) < next(b) ? -1 : 1));
  const pastCount = (rows || []).filter((h) => h.past).length;

  return (
    <div className="stack">
      <section className="card">
        <h2 className="h3">Add a holiday or closure</h2>
        <form
          className="grid-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await run(() => api('/admin/holidays', { method: 'POST', body: f }))) setF(blank);
          }}
        >
          <label>
            Name
            <input value={f.name} maxLength={100} placeholder="e.g. Liberation Day" onChange={(e) => setF({ ...f, name: e.target.value })} required />
          </label>
          <label>
            From
            <input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value, endDate: f.endDate < e.target.value ? e.target.value : f.endDate })} required />
          </label>
          <label>
            To
            <input type="date" value={f.endDate} min={f.startDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} required />
          </label>
          <label>
            Kind
            <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
              <option value="public">Public holiday</option>
              <option value="closure">Office closure</option>
            </select>
          </label>
          <label className="inline-label">
            <input type="checkbox" checked={f.yearly} onChange={(e) => setF({ ...f, yearly: e.target.checked })} /> Every year on these dates
          </label>
          <button className="primary" disabled={busy}>
            Add
          </button>
        </form>
        <p className="muted small">Nobody is expected on these days: no late or absence alerts, and part-timers' contract hours are reduced. Anyone who works anyway is still recorded.</p>
        <Msg msg={msg} />
      </section>

      <section className="card">
        <div className="section-head">
          <h2 className="h3 no-margin">Holidays & closures</h2>
          {pastCount > 0 && (
            <label className="inline-label small">
              <input type="checkbox" checked={showPast} onChange={(e) => setShowPast(e.target.checked)} /> Show past ({pastCount})
            </label>
          )}
        </div>
        {!rows ? (
          <p className="muted">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="muted">None coming up. Add your public holidays for the year above.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>When</th>
                  <th>Kind</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((h) => (
                  <tr key={h.id} className={h.past ? 'dim' : ''}>
                    <td>{h.name}</td>
                    <td>
                      {h.yearly
                        ? `${dayMonth(h.startDate)}${h.endDate !== h.startDate ? ` – ${dayMonth(h.endDate)}` : ''}`
                        : h.startDate === h.endDate
                          ? formatDate(h.startDate)
                          : `${formatDate(h.startDate)} – ${formatDate(h.endDate)}`}
                      {h.yearly && <div className="muted small">Every year · next {formatDate(next(h))}</div>}
                    </td>
                    <td>{h.kind === 'closure' ? 'Closure' : 'Public holiday'}</td>
                    <td className="actions">
                      <button className="danger" onClick={() => window.confirm(`Remove ${h.name}?`) && run(() => api(`/admin/holidays/${h.id}`, { method: 'DELETE' }))}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

const MATRIX = [
  ['Check in and out, see own history', 'yes', 'yes', 'yes'],
  ['Request time off and follow its status', 'yes', 'yes', 'yes'],
  ['See attendance', 'own', 'team', 'all'],
  ['Approve, decline and record time off', 'no', 'team', 'all'],
  ['Fix check-in and check-out times', 'no', 'team', 'all'],
  ['Reports (download and email)', 'no', 'team', 'all'],
  ['Late and absence alert emails (HR: the addresses in Office, hours & alerts)', 'no', 'team', 'all'],
  ['Add people, set roles and contracts', 'no', 'no', 'yes'],
  ['Holidays, office, hours, branding, security', 'no', 'no', 'yes'],
];
const CELL = { yes: ['✓', 'Yes'], no: ['—', 'No'], own: ['Own', 'Own only'], team: ['Team', 'Their team only'], all: ['All', 'Everyone'] };

export function Roles() {
  return (
    <section className="card">
      <h2 className="h3">Roles & permissions</h2>
      <p className="muted small">Set someone's role and manager in Employees › Edit. “Team” means the people who report to that manager.</p>
      <div className="table-wrap">
        <table className="matrix">
          <thead>
            <tr>
              <th>Permission</th>
              <th>Employee</th>
              <th>Manager</th>
              <th>HR admin</th>
            </tr>
          </thead>
          <tbody>
            {MATRIX.map(([label, ...cells]) => (
              <tr key={label}>
                <td>{label}</td>
                {cells.map((c, i) => (
                  <td key={i} className={`cell ${c}`}>
                    <span aria-hidden="true">{CELL[c][0]}</span>
                    <span className="sr-only">{CELL[c][1]}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
