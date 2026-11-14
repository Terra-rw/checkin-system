import { useEffect, useState } from 'react';
import { api, download } from '../../api.js';

const TYPES = [
  ['daily', 'Daily log', 'Every check-in and check-out, one row per person per day'],
  ['summary', 'Summary per person', 'Days present, lateness and hours worked, totalled'],
  ['issues', 'Late, early & absent only', 'Just the exceptions, for follow-up'],
  ['hours', 'Hours vs contract', 'Part-timers: hours worked against contracted hours, for payroll'],
];
const FORMATS = [
  ['xlsx', 'XLSX', 'Excel', 'Formatted sheet', 'xl'],
  ['csv', 'CSV', 'CSV', 'Plain data for other systems', 'csv'],
  ['pdf', 'PDF', 'PDF', 'Ready to print or sign', 'pdf'],
];

function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function presetRange(preset, today) {
  const [y, m] = today.split('-').map(Number);
  const pad = (n) => String(n).padStart(2, '0');
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const monday = addDays(today, -((weekday + 6) % 7));
  switch (preset) {
    case 'today':
      return [today, today];
    case 'this-week':
      return [monday, today];
    case 'last-week':
      return [addDays(monday, -7), addDays(monday, -1)];
    case 'this-month':
      return [`${y}-${pad(m)}-01`, today];
    case 'last-month': {
      const ly = m === 1 ? y - 1 : y;
      const lm = m === 1 ? 12 : m - 1;
      return [`${ly}-${pad(lm)}-01`, addDays(`${y}-${pad(m)}-01`, -1)];
    }
    default:
      return null;
  }
}

export default function Reports({ me }) {
  const today = me.todayDate;
  const [type, setType] = useState('summary');
  const [preset, setPreset] = useState('this-month');
  const [[from, to], setRange] = useState(presetRange('this-month', today));
  const [userId, setUserId] = useState('');
  const [format, setFormat] = useState('xlsx');
  const [people, setPeople] = useState([]);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState('');

  useEffect(() => {
    api('/team/people').then(setPeople);
  }, []);

  const query = `type=${type}&from=${from}&to=${to}${userId ? `&userId=${userId}` : ''}`;

  useEffect(() => {
    setError('');
    setPreview(null);
    if (!from || !to || from > to) {
      setError('Choose a valid date range.');
      return;
    }
    api(`/team/reports?${query}`).then(setPreview).catch((e) => setError(e.message));
  }, [query, from, to]);

  function choosePreset(p) {
    setPreset(p);
    const r = presetRange(p, today);
    if (r) setRange(r);
  }

  async function doDownload() {
    setBusy('download');
    setMsg(null);
    try {
      const name = await download(`/team/reports?${query}&format=${format}`);
      setMsg({ type: 'success', text: `Downloaded ${name}.` });
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setBusy('');
    }
  }

  async function emailMe() {
    setBusy('email');
    setMsg(null);
    try {
      const d = await api('/team/reports/email', { method: 'POST', body: { type, from, to, userId: userId || null, format } });
      setMsg({ type: 'success', text: d.message });
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setBusy('');
    }
  }

  const ext = FORMATS.find((f) => f[0] === format)[1];
  const visible = type === 'hours' ? people.filter((p) => p.partTime) : people;
  const activePeople = visible.filter((p) => p.active);

  return (
    <div className="stack">
      <div>
        <h1 className="h1">Reports</h1>
        <p className="muted">
          Pick what to include, preview it, then download as Excel, CSV or PDF.{me.user.role === 'manager' ? ' Reports cover the people who report to you.' : ''}
        </p>
      </div>

      <section className="card stack-sm" aria-labelledby="rep-build">
        <h2 id="rep-build" className="h3">
          1. What to include
        </h2>
        <fieldset className="plain">
          <legend className="muted small">Report type</legend>
          <div className="choice-grid">
            {TYPES.map(([key, label, desc]) => (
              <button type="button" key={key} className={type === key ? 'choice on' : 'choice'} aria-pressed={type === key} onClick={() => setType(key)}>
                <span className="strong">{label}</span>
                <span className="muted small">{desc}</span>
              </button>
            ))}
          </div>
        </fieldset>
        <div className="toolbar">
          <label>
            Period
            <select value={preset} onChange={(e) => choosePreset(e.target.value)}>
              <option value="today">Today</option>
              <option value="this-week">This week</option>
              <option value="last-week">Last week</option>
              <option value="this-month">This month</option>
              <option value="last-month">Last month</option>
              <option value="custom">Custom dates</option>
            </select>
          </label>
          <label>
            From
            <input
              type="date"
              value={from}
              onChange={(e) => {
                setPreset('custom');
                setRange([e.target.value, to]);
              }}
            />
          </label>
          <label>
            To
            <input
              type="date"
              value={to}
              min={from}
              onChange={(e) => {
                setPreset('custom');
                setRange([from, e.target.value]);
              }}
            />
          </label>
          <label>
            People
            <select value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Everyone ({activePeople.length})</option>
              {visible.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.active ? '' : ' (disabled)'}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section className="card" aria-labelledby="rep-prev">
        <div className="section-head">
          <h2 id="rep-prev" className="h3">
            2. Preview
          </h2>
          {preview && (
            <span className="muted small">
              {preview.title} · {preview.period} · {preview.workDayCount} work days ·{' '}
              {preview.total > preview.rows.length ? `first ${preview.rows.length} of ${preview.total} rows` : `${preview.total} rows`}
            </span>
          )}
        </div>
        {error && <div className="alert error">{error}</div>}
        {!preview && !error && <p className="muted">Loading…</p>}
        {preview && (
          <>
            {preview.warnings?.map((w) => (
              <div key={w} className="alert warn">
                {w} Fix them in {me.user.role === 'admin' ? 'Attendance' : 'My team'}.
              </div>
            ))}
            <div className="stats">
              {preview.stats.map((s) => (
                <div className="stat" key={s.label}>
                  <div className="value">{s.value}</div>
                  <div className="label">{s.label}</div>
                </div>
              ))}
            </div>
            {preview.rows.length === 0 ? (
              <p className="muted">Nothing to show for this period.</p>
            ) : (
              <div className="table-wrap">
                <table className="tabular">
                  <thead>
                    <tr>
                      {preview.columns.map((c) => (
                        <th key={c.key} className={c.type === 'number' || c.type === 'duration' ? 'num' : ''}>
                          {c.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((r, i) => (
                      <tr key={i}>
                        {preview.columns.map((c) => (
                          <td key={c.key} className={c.type === 'number' || c.type === 'duration' ? 'num' : ''}>
                            {c.key === 'status' ? <StatusText text={r[c.key]} /> : r[c.key]}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="muted small">
              Times of 60 min or more show as hours and minutes. Excel and CSV files also include a minutes column, so totals can still be added up.
            </p>
          </>
        )}
      </section>

      <section className="card stack-sm" aria-labelledby="rep-dl">
        <h2 id="rep-dl" className="h3">
          3. Download
        </h2>
        <fieldset className="plain">
          <legend className="muted small">Format</legend>
          <div className="row">
            {FORMATS.map(([key, extLabel, label, desc, cls]) => (
              <button type="button" key={key} className={format === key ? 'choice fmt on' : 'choice fmt'} aria-pressed={format === key} onClick={() => setFormat(key)}>
                <span className={`file-icon ${cls}`} aria-hidden="true">
                  {extLabel}
                </span>
                <span className="fmt-text">
                  <span className="strong">{label}</span>
                  <span className="muted small">{desc}</span>
                </span>
              </button>
            ))}
          </div>
        </fieldset>
        <div className="row">
          <button className="primary big" onClick={doDownload} disabled={Boolean(busy) || !preview}>
            {busy === 'download' ? 'Preparing…' : `Download ${ext}`}
          </button>
          <button className="big" onClick={emailMe} disabled={Boolean(busy) || !preview}>
            {busy === 'email' ? 'Sending…' : 'Email it to me'}
          </button>
        </div>
        {msg && <div className={`alert ${msg.type}`}>{msg.text}</div>}
        <p className="muted small">To get last week's summary by email every Monday, turn it on in Settings › Email alerts.</p>
      </section>
    </div>
  );
}

function StatusText({ text }) {
  if (text === 'On time') return <span className="badge green">On time</span>;
  if (text === 'Absent') return <span className="badge red">Absent</span>;
  if (/Late|Left early|No check-out/.test(text)) return <span className="badge amber">{text}</span>;
  return <span className="badge blue">{text}</span>;
}
