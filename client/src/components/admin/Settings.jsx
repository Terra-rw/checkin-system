import { useEffect, useMemo, useState } from 'react';
import { api, getPosition, DAY_NAMES } from '../../api.js';

function timeZones() {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
}

export default function Settings() {
  const [s, setS] = useState(null);
  const [smtp, setSmtp] = useState(false);
  const [msg, setMsg] = useState(null);
  const [locating, setLocating] = useState(false);
  const zones = useMemo(timeZones, []);

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

  const toggleDay = (d) => setS({ ...s, workDays: s.workDays.includes(d) ? s.workDays.filter((x) => x !== d) : [...s.workDays, d] });
  const hasLocation = s.officeLat !== null && s.officeLat !== '' && s.officeLng !== null && s.officeLng !== '';

  return (
    <form className="stack" onSubmit={save}>
      <section className="card">
        <h2 className="h3">Office location (geofence)</h2>
        <p className="muted small">
          People can only check in or out when their device reports a position within the radius below. The easiest way to set this is to open this
          page while standing in the office and press "Use my current location".
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
            {locating ? 'Locating…' : 'Use my current location'}
          </button>
          {hasLocation && (
            <a className="link" href={`https://www.google.com/maps?q=${s.officeLat},${s.officeLng}`} target="_blank" rel="noreferrer">
              View on map ↗
            </a>
          )}
        </div>
      </section>

      <section className="card">
        <h2 className="h3">Working hours</h2>
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
            {zones.length ? (
              <select value={s.timezone} onChange={set('timezone')}>
                {!zones.includes(s.timezone) && <option>{s.timezone}</option>}
                {zones.map((z) => (
                  <option key={z}>{z}</option>
                ))}
              </select>
            ) : (
              <input value={s.timezone} onChange={set('timezone')} placeholder="e.g. Africa/Kigali" />
            )}
          </label>
        </div>
        <fieldset className="days">
          <legend className="sr-only">Work days</legend>
          {DAY_NAMES.map((name, d) => (
            <button type="button" key={d} className={s.workDays.includes(d) ? 'day on' : 'day'} aria-pressed={s.workDays.includes(d)} onClick={() => toggleDay(d)}>
              {name}
            </button>
          ))}
        </fieldset>
      </section>

      <section className="card">
        <h2 className="h3">Email alerts</h2>
        {!smtp && (
          <div className="alert warn">
            SMTP is not configured on the server, so emails are only printed in the server console. Set the SMTP_* values on the server to send
            real emails.
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
        <label className="check">
          <input type="checkbox" checked={s.weeklyReport} onChange={set('weeklyReport')} />
          Email last week's summary report (Excel) every Monday
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
