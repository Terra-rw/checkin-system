// Team attendance (managers: their team; HR: everyone). Each person's plan for the day
// decides whether they're expected; fixes to check-in/out times keep an audit trail.
import { useCallback, useEffect, useState } from 'react';
import { api, formatTime, formatDate, formatDuration, formatDateTime } from '../../api.js';
import { Modal, Stat, StatusBadges, useRunner, Msg } from '../ui.jsx';

const hhmm = (iso, tz) => (iso ? new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)) : '');

export default function Attendance({ me }) {
  const tz = me.settings.timezone;
  const [from, setFrom] = useState(me.todayDate);
  const [to, setTo] = useState(me.todayDate);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [fixing, setFixing] = useState(null);
  const [history, setHistory] = useState(null);
  const isAdmin = me.user.role === 'admin';

  const load = useCallback(() => {
    setError('');
    return api(`/team/attendance?from=${from}&to=${to}`).then(setData).catch((e) => setError(e.message));
  }, [from, to]);
  useEffect(() => {
    load();
  }, [load]);

  const rows = data?.rows || [];
  const single = data && data.from === data.to;
  const count = (s) => rows.filter((r) => r.status === s).length;
  const expected = rows.filter((r) => r.plan?.expected);
  const stats = single && {
    present: rows.filter((r) => r.check_in_at && r.plan?.expected).length,
    expected: expected.length,
    late: rows.filter((r) => r.late).length,
    absent: count('absent'),
    off: count('not_expected'),
    noOut: count('no_checkout'),
  };

  return (
    <section className="card">
      <div className="section-head">
        <h1 className="h2 no-margin">{isAdmin ? 'Attendance' : 'My team'}</h1>
        {!isAdmin && <span className="muted small">{rows.length ? `${new Set(rows.map((r) => r.user_id)).size} people` : ''}</span>}
      </div>
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
          <Stat label="Present (of expected)" value={`${stats.present}/${stats.expected}`} />
          <Stat label="Late" value={stats.late} tone={stats.late ? 'amber' : ''} />
          <Stat label="Absent" value={stats.absent} tone={stats.absent ? 'red' : ''} />
          <Stat label="Off, leave or not scheduled" value={stats.off} />
        </div>
      )}
      {stats?.noOut > 0 && (
        <div className="alert warn">
          {stats.noOut} {stats.noOut === 1 ? 'person has' : 'people have'} no check-out. Use <strong>Fix</strong> to add the time they left.
        </div>
      )}

      {data && rows.length === 0 ? (
        <p className="muted">{isAdmin ? 'No records in this range.' : 'Nobody reports to you yet, or there are no records in this range.'}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {!single && <th>Date</th>}
                <th>Name</th>
                {single && <th className="hide-sm">Today's plan</th>}
                <th>In</th>
                <th>Out</th>
                <th className="num">Worked</th>
                <th>Status</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.user_id}-${r.date}`}>
                  {!single && <td>{formatDate(r.date)}</td>}
                  <td>
                    {r.name}
                    <div className="muted small">{r.contract}</div>
                  </td>
                  {single && <td className="hide-sm muted small">{r.plan?.label || '—'}</td>}
                  <td>{formatTime(r.check_in_at, tz)}</td>
                  <td>{formatTime(r.check_out_at, tz)}</td>
                  <td className="num">{r.workedMinutes != null ? formatDuration(r.workedMinutes) : '—'}</td>
                  <td>
                    <StatusBadges r={r} />
                  </td>
                  <td className="actions">
                    {r.id && !me.support && (
                      <button onClick={() => setFixing(r)} aria-label={`Fix ${r.name}'s times for ${r.date}`}>
                        Fix
                      </button>
                    )}
                    {r.edited && (
                      <button className="link" onClick={() => setHistory(r)}>
                        History
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">To download or print attendance, use the Reports tab.</p>
      {fixing && <FixDialog r={fixing} tz={tz} onClose={() => setFixing(null)} onDone={load} />}
      {history && <HistoryDialog r={history} tz={tz} onClose={() => setHistory(null)} />}
    </section>
  );
}

function FixDialog({ r, tz, onClose, onDone }) {
  const [checkIn, setIn] = useState(hhmm(r.check_in_at, tz));
  const [checkOut, setOut] = useState(hhmm(r.check_out_at, tz));
  const [reason, setReason] = useState('');
  const { msg, busy, run } = useRunner(onDone);
  return (
    <Modal title={`Fix times: ${r.name}, ${formatDate(r.date)}`} onClose={onClose}>
      <form
        className="stack-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          const body = { reason };
          if (checkIn !== hhmm(r.check_in_at, tz)) body.checkIn = checkIn;
          if (checkOut && checkOut !== hhmm(r.check_out_at, tz)) body.checkOut = checkOut;
          if (await run(() => api(`/team/attendance/${r.id}`, { method: 'PATCH', body }))) onClose();
        }}
      >
        <div className="grid-form">
          <label>
            Checked in
            <input type="time" value={checkIn} onChange={(e) => setIn(e.target.value)} required />
          </label>
          <label>
            Checked out
            <input type="time" value={checkOut} onChange={(e) => setOut(e.target.value)} />
          </label>
        </div>
        <label>
          Reason (kept in the history)
          <input value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={300} placeholder="e.g. Forgot to check out, confirmed with supervisor" required />
        </label>
        <p className="muted small no-margin">A check-out earlier than the check-in is treated as the next morning (night shifts). Late and early are worked out again.</p>
        <div className="row">
          <button className="primary" disabled={busy}>
            Save fix
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
        <Msg msg={msg} />
      </form>
    </Modal>
  );
}

function HistoryDialog({ r, tz, onClose }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    api(`/team/attendance/${r.id}/history`).then(setData);
  }, [r.id]);
  return (
    <Modal title={`Changes: ${r.name}, ${formatDate(r.date)}`} onClose={onClose}>
      {!data ? (
        <p className="muted">Loading…</p>
      ) : data.changes.length === 0 ? (
        <p className="muted">No changes recorded.</p>
      ) : (
        <ul className="events">
          {data.changes.map((c, i) => (
            <li key={i}>
              <strong>{c.field === 'check_in' ? 'Check-in' : 'Check-out'}</strong> {c.from || '—'} → {c.to || '—'}
              <div className="muted small">
                {c.by}, {formatDateTime(c.at, tz)} · “{c.reason}”
              </div>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
