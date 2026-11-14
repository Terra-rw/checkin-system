import { useEffect, useState } from 'react';
import { api, formatDateTime } from '../../api.js';

const EVENT_LABELS = {
  new_device: ['New device', ''],
  password_reset: ['Password reset', 'amber'],
  password_reset_requested: ['Reset requested', ''],
  invite_accepted: ['Joined', 'green'],
  locked: ['Locked', 'red'],
  device_removed: ['Device removed', ''],
  support_access: ['Support access', 'amber'],
  setting: ['Setting changed', 'amber'],
  created: ['Created', ''],
  suspended: ['Suspended', 'red'],
  active: ['Reactivated', 'green'],
};

export default function Security({ me }) {
  const tz = me.settings.timezone;
  const [s, setS] = useState(null);
  const [data, setData] = useState(null);
  const [msg, setMsg] = useState(null);
  const [listMsg, setListMsg] = useState(null);

  const load = () => api('/admin/security').then(setData);
  useEffect(() => {
    api('/admin/settings').then((d) => setS(d.settings));
    load();
  }, []);

  async function save(e) {
    e.preventDefault();
    setMsg(null);
    try {
      const { require2fa, trustDays, codeMinutes, resetMinutes } = s;
      const d = await api('/admin/settings', { method: 'PUT', body: { require2fa, trustDays, codeMinutes, resetMinutes } });
      setS(d.settings);
      setMsg({ type: 'success', text: 'Saved.' });
      load();
    } catch (err) {
      setMsg({ type: 'error', text: err.message });
    }
  }

  async function act(fn) {
    setListMsg(null);
    try {
      const d = await fn();
      setListMsg({ type: 'success', text: d.message });
      load();
    } catch (err) {
      setListMsg({ type: 'error', text: err.message });
    }
  }

  const set = (k) => (e) => setS({ ...s, [k]: e.target.type === 'checkbox' ? e.target.checked : Number(e.target.value) });

  return (
    <div className="stack">
      <div className="split">
        {s && (
          <form className="card split-side stack-sm" onSubmit={save} aria-labelledby="sec-rules">
            <h2 id="sec-rules" className="h3">
              Sign-in security
            </h2>
            <label className="check">
              <input type="checkbox" checked={s.require2fa} onChange={set('require2fa')} />
              <span>
                <strong>Email a 6-digit code on new devices</strong>
                <br />
                <span className="muted small">Asked once per phone or browser, then remembered.</span>
              </span>
            </label>
            {!s.require2fa && <div className="alert warn">With this off, a stolen password is enough to log in as that person.</div>}
            <label>
              Remember a verified device for
              <select value={s.trustDays} onChange={set('trustDays')}>
                {[7, 30, 90, 180, 365].map((d) => (
                  <option key={d} value={d}>
                    {d} days
                  </option>
                ))}
              </select>
            </label>
            <label>
              Device code expires after
              <select value={s.codeMinutes} onChange={set('codeMinutes')}>
                {[5, 10, 15, 30].map((m) => (
                  <option key={m} value={m}>
                    {m} min
                  </option>
                ))}
              </select>
            </label>
            <label>
              Password reset link expires after
              <select value={s.resetMinutes} onChange={set('resetMinutes')}>
                {[15, 30, 60, 120].map((m) => (
                  <option key={m} value={m}>
                    {m < 60 ? `${m} min` : `${m / 60} hr`}
                  </option>
                ))}
              </select>
            </label>
            <p className="muted small">After 5 wrong codes or 10 wrong passwords, the account is locked for 15 min and the person gets an email.</p>
            {msg && <div className={`alert ${msg.type}`}>{msg.text}</div>}
            <button className="primary big">Save</button>
          </form>
        )}

        <section className="card split-main" aria-labelledby="sec-devices">
          <div className="section-head">
            <h2 id="sec-devices" className="h3">
              Trusted devices {data ? `(${data.devices.length})` : ''}
            </h2>
            {data?.devices.length > 0 && (
              <button
                className="danger"
                onClick={() => {
                  if (window.confirm('Forget every trusted device? Everyone will need a new email code next time they log in.')) {
                    act(() => api('/admin/devices/forget-all', { method: 'POST' }));
                  }
                }}
              >
                Forget all devices
              </button>
            )}
          </div>
          <p className="muted small">If a phone is lost or shared, remove it here. That person will need a new email code next time they log in on it.</p>
          {listMsg && <div className={`alert ${listMsg.type}`}>{listMsg.text}</div>}
          {data && data.devices.length === 0 ? (
            <p className="muted">No trusted devices yet.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Person</th>
                    <th>Device</th>
                    <th>Last used</th>
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data?.devices.map((d) => (
                    <tr key={d.id}>
                      <td>
                        <div className="strong">{d.name}</div>
                        <div className="muted small">{d.email}</div>
                      </td>
                      <td>
                        {d.label}
                        <div className="muted small">Verified {formatDateTime(d.created_at, tz)}</div>
                      </td>
                      <td>{formatDateTime(d.last_used_at, tz)}</td>
                      <td className="actions">
                        <button onClick={() => act(() => api(`/admin/devices/${d.id}`, { method: 'DELETE' }))}>Remove</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <section className="card" aria-labelledby="sec-log">
        <h2 id="sec-log" className="h3">
          Recent security activity
        </h2>
        {data && data.events.length === 0 ? (
          <p className="muted">Nothing yet.</p>
        ) : (
          <ul className="events">
            {data?.events.map((e, i) => {
              const [label, tone] = EVENT_LABELS[e.kind] || [e.kind, ''];
              return (
                <li key={i}>
                  <span className={`badge ${tone}`}>{label}</span>
                  <span className="grow">{e.detail}</span>
                  <span className="muted small">{formatDateTime(e.created_at, tz)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
