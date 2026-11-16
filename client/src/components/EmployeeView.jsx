import { useEffect, useState } from 'react';
import { api, getPosition, formatTime, formatDate } from '../api.js';
import { photoStyle } from './Logo.jsx';
import { StatusBadges } from './ui.jsx';

export { StatusBadges };

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
          {photo ? 'Today' : s.officeName} · <PlanText plan={me.plan} s={s} />
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
          You must be within {s.radiusMeters} m of the office.
          {me.plan?.expected
            ? ` Check-ins after ${me.plan.start} (+${s.graceMinutes} min grace) are reported as late.`
            : me.plan?.flexible
              ? ' Your hours are flexible: just check in and out so your time is counted.'
              : " You're not expected today, so nothing is marked late. You can still check in if you work."}
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

/** Today's plan in words: "08:00–17:00", "Day off", "Sick", "Holiday: …", "Flexible hours". */
function PlanText({ plan, s }) {
  if (!plan) return `${s.workStart}–${s.workEnd}`;
  if (plan.reason === 'flexible') return plan.label === 'Flexible' ? 'Flexible hours' : plan.label;
  return plan.label;
}
