import { useEffect, useState } from 'react';
import { api, getPosition, formatTime, formatDate, formatDuration } from '../api.js';
import { photoStyle } from './Logo.jsx';

function useClock(timeZone) {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return {
    time: new Intl.DateTimeFormat(undefined, { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(now),
    date: new Intl.DateTimeFormat(undefined, { timeZone, weekday: 'long', day: 'numeric', month: 'long' }).format(now),
  };
}

export function StatusBadges({ r }) {
  if (!r || !r.check_in_at) return <span className="badge red">Absent</span>;
  return (
    <>
      {r.late ? <span className="badge amber">Late {formatDuration(r.late_minutes)}</span> : <span className="badge green">On time</span>}
      {r.early ? <span className="badge amber">Left {formatDuration(r.early_minutes)} early</span> : null}
    </>
  );
}

export default function EmployeeView({ me, onChange }) {
  const { settings: s, today } = me;
  const clock = useClock(s.timezone);
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState(null);

  const state = !today ? 'in' : !today.check_out_at ? 'out' : 'done';
  const photo = photoStyle(me.institution);

  async function act(kind) {
    setResult(null);
    setBusy('Getting your location…');
    try {
      const pos = await getPosition();
      setBusy(kind === 'in' ? 'Checking in…' : 'Checking out…');
      const res = await api(`/attendance/check-${kind}`, { method: 'POST', body: pos });
      setResult({ type: res.record.late || res.record.early ? 'warn' : 'success', text: res.message });
      await onChange();
    } catch (err) {
      setResult({ type: 'error', text: err.message });
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="stack">
      <section className="card hero">
        {photo ? (
          <div className={`hero-photo ${me.institution.photoDim ? 'dim' : ''}`} style={photo}>
            <div className="hero-photo-text">
              <div className="small">
                {clock.date} · {s.officeName}
              </div>
              <div className="clock">{clock.time}</div>
            </div>
          </div>
        ) : (
          <>
            <div className="muted">{clock.date}</div>
            <div className="clock">{clock.time}</div>
          </>
        )}
        <div className="muted small">
          {photo ? 'Work hours' : s.officeName} · {s.workStart}–{s.workEnd}
          {!me.isWorkDay && ' · Not a scheduled work day'}
        </div>

        {!s.officeConfigured ? (
          <div className="alert warn">The office location hasn't been set up yet. Ask an admin to configure it.</div>
        ) : state === 'done' ? (
          <div className="done">
            <div className="done-icon">✓</div>
            <div>You're done for today.</div>
          </div>
        ) : (
          <button
            className={`big-btn ${state === 'in' ? 'in' : 'out'}`}
            disabled={Boolean(busy)}
            onClick={() => act(state)}
          >
            {busy || (state === 'in' ? 'Check in' : 'Check out')}
          </button>
        )}

        {result && <div className={`alert ${result.type}`}>{result.text}</div>}

        <div className="today-grid">
          <div>
            <div className="label">Checked in</div>
            <div className="value">{formatTime(today?.check_in_at, s.timezone)}</div>
          </div>
          <div>
            <div className="label">Checked out</div>
            <div className="value">{formatTime(today?.check_out_at, s.timezone)}</div>
          </div>
          <div>
            <div className="label">Status</div>
            <div className="value">{today ? <StatusBadges r={today} /> : '—'}</div>
          </div>
        </div>
        <p className="muted small">
          You must be within {s.radiusMeters} m of the office. Check-ins after {s.workStart} (+{s.graceMinutes} min
          grace) are reported as late.
        </p>
      </section>

      <section className="card">
        <h3>Last 14 days</h3>
        {me.recent.length === 0 ? (
          <p className="muted">No attendance recorded yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>In</th>
                  <th>Out</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {me.recent.map((r) => (
                  <tr key={r.id}>
                    <td>{formatDate(r.date)}</td>
                    <td>{formatTime(r.check_in_at, s.timezone)}</td>
                    <td>{formatTime(r.check_out_at, s.timezone)}</td>
                    <td>
                      <StatusBadges r={r} />
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
