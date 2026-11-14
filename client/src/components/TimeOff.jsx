// Time off: employees request and follow their own requests; managers and HR approve,
// decline, record and cancel time off for the people they look after.
import { useCallback, useEffect, useState } from 'react';
import { api, formatDate, DAY_NAMES } from '../api.js';
import { Modal, TimeOffStatus, useRunner, Msg } from './ui.jsx';

export const TYPES = [
  ['sick', 'Sick'],
  ['personal', 'Personal'],
  ['maternity', 'Maternity leave'],
  ['paternity', 'Paternity leave'],
  ['mission', 'On mission'],
  ['adjusted', 'Adjusted hours'],
];
const TYPE_HELP = {
  mission: 'Working away from the office. The day counts as worked, so no check-in is needed.',
  adjusted: 'An agreed later start or earlier finish. Arriving or leaving within it is not marked late or early.',
};

const days = (n) => (n == null ? '' : `${n} working day${n === 1 ? '' : 's'}`);

/** The request / record form. `forUser` set = staff recording for someone (auto-approved). */
function TimeOffForm({ me, people, onSaved }) {
  const blank = { userId: '', type: 'sick', startDate: me.todayDate, endDate: me.todayDate, part: 'full', arriveBy: '', leaveFrom: '', weekdays: [], reason: '' };
  const [f, setF] = useState(blank);
  const { msg, busy, run } = useRunner(onSaved);
  const staff = Boolean(people);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const adjusted = f.type === 'adjusted';
  const half = !adjusted && f.part !== 'full';

  async function submit(e) {
    e.preventDefault();
    const body = { ...f, endDate: half ? f.startDate : f.endDate, userId: staff ? Number(f.userId) : undefined };
    const ok = await run(() => api(staff ? '/team/time-off' : '/time-off', { method: 'POST', body }));
    if (ok) setF({ ...blank, userId: f.userId });
  }

  return (
    <form className="stack-sm" onSubmit={submit}>
      <div className="grid-form">
        {staff && (
          <label>
            Person
            <select value={f.userId} onChange={set('userId')} required>
              <option value="">Choose…</option>
              {people
                .filter((p) => p.active && p.id !== me.user.id)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
        )}
        <label>
          Type
          <select value={f.type} onChange={set('type')}>
            {TYPES.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
        {!adjusted && (
          <label>
            Length
            <select value={f.part} onChange={set('part')}>
              <option value="full">Full day(s)</option>
              <option value="am">Morning only</option>
              <option value="pm">Afternoon only</option>
            </select>
          </label>
        )}
        <label>
          {half ? 'Date' : 'From'}
          <input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value, endDate: f.endDate < e.target.value ? e.target.value : f.endDate })} required />
        </label>
        {!half && (
          <label>
            To
            <input type="date" value={f.endDate} min={f.startDate} onChange={set('endDate')} required />
          </label>
        )}
        {adjusted && (
          <>
            <label>
              Arrive by (optional)
              <input type="time" value={f.arriveBy} onChange={set('arriveBy')} />
            </label>
            <label>
              Leave from (optional)
              <input type="time" value={f.leaveFrom} onChange={set('leaveFrom')} />
            </label>
          </>
        )}
      </div>
      {adjusted && (
        <fieldset className="plain">
          <legend className="muted small">Only on these days (leave empty for every day in the range)</legend>
          <div className="days">
            {[1, 2, 3, 4, 5, 6, 0].map((d) => {
              const on = f.weekdays.includes(d);
              return (
                <button
                  type="button"
                  key={d}
                  className={on ? 'day on' : 'day'}
                  aria-pressed={on}
                  onClick={() => setF({ ...f, weekdays: on ? f.weekdays.filter((x) => x !== d) : [...f.weekdays, d] })}
                >
                  {DAY_NAMES[d]}
                </button>
              );
            })}
          </div>
        </fieldset>
      )}
      {TYPE_HELP[f.type] && <p className="muted small no-margin">{TYPE_HELP[f.type]}</p>}
      <label>
        {staff ? 'Note (optional)' : 'Reason (optional, seen by your approver)'}
        <input value={f.reason} maxLength={500} onChange={set('reason')} />
      </label>
      <div className="row">
        <button className="primary" disabled={busy}>
          {staff ? 'Save (approved)' : 'Send request'}
        </button>
        <span className="muted small">
          {staff ? 'Recorded time off is approved straight away and the person gets an email.' : `Goes to ${me.manager?.name || 'HR'} for approval.`}
        </span>
      </div>
      <Msg msg={msg} />
    </form>
  );
}

function Range({ t }) {
  return (
    <>
      {t.startDate === t.endDate ? formatDate(t.startDate) : `${formatDate(t.startDate)} – ${formatDate(t.endDate)}`}
      {t.part === 'am' ? ' · morning' : t.part === 'pm' ? ' · afternoon' : ''}
      {t.type === 'adjusted' && (
        <div className="muted small">
          {[t.arriveBy && `arrive by ${t.arriveBy}`, t.leaveFrom && `leave from ${t.leaveFrom}`].filter(Boolean).join(', ')}
          {t.weekdays?.length ? ` · ${t.weekdays.map((d) => DAY_NAMES[d]).join(', ')}` : ''}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- employee: my requests

export function MyTimeOff({ me }) {
  const [data, setData] = useState(null);
  const load = useCallback(() => api('/time-off').then(setData), []);
  const { msg, run } = useRunner(load);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="stack">
      <section className="card">
        <h2 className="h3">Request time off</h2>
        <TimeOffForm me={me} onSaved={load} />
      </section>
      <section className="card">
        <h2 className="h3">My requests</h2>
        <Msg msg={msg} />
        {!data ? (
          <p className="muted">Loading…</p>
        ) : data.requests.length === 0 ? (
          <p className="muted">No requests yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>When</th>
                  <th>Status</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.requests.map((t) => (
                  <tr key={t.id}>
                    <td>
                      {t.typeLabel}
                      <div className="muted small">{days(t.workingDays)}</div>
                    </td>
                    <td>
                      <Range t={t} />
                    </td>
                    <td>
                      <TimeOffStatus status={t.status} />
                      {t.decidedBy && t.status !== 'pending' && <div className="muted small">by {t.decidedBy}</div>}
                      {t.decisionNote && <div className="muted small">“{t.decisionNote}”</div>}
                    </td>
                    <td className="actions">
                      {t.status === 'pending' && <button onClick={() => run(() => api(`/time-off/${t.id}/cancel`, { method: 'POST' }))}>Cancel</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small">
          Requests go to {data?.approver || 'your manager'}. To change approved time off, ask them.
        </p>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- managers & HR

export function TeamTimeOff({ me, onChange }) {
  const [tab, setTab] = useState(me.pendingApprovals ? 'inbox' : 'all');
  const [rows, setRows] = useState(null);
  const [people, setPeople] = useState([]);
  const [deciding, setDeciding] = useState(null);
  const load = useCallback(async () => {
    setRows(await api('/team/time-off'));
    onChange?.();
  }, [onChange]);
  const { msg, run } = useRunner(load);
  useEffect(() => {
    load();
    api('/team/people').then(setPeople);
  }, [load]);

  const pending = (rows || []).filter((t) => t.status === 'pending');
  const list = tab === 'inbox' ? pending : rows || [];
  const isAdmin = me.user.role === 'admin';

  return (
    <div className="stack">
      <div>
        <h1 className="h1">Time off</h1>
        <p className="muted">
          {isAdmin ? 'Requests from everyone.' : 'Requests from your team.'} People on approved time off, a holiday or a day off are never marked absent or late.
        </p>
      </div>
      <nav className="subtabs" aria-label="Time off sections">
        {[
          ['inbox', `To approve${pending.length ? ` (${pending.length})` : ''}`],
          ['all', 'All time off'],
          ['record', 'Record time off'],
          ...(me.support ? [] : [['mine', 'My requests']]),
        ].map(([k, l]) => (
          <button key={k} className={tab === k ? 'active' : ''} aria-current={tab === k ? 'page' : undefined} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </nav>

      {tab === 'mine' && <MyTimeOff me={me} />}
      {tab === 'record' && (
        <section className="card">
          <h2 className="h3">Record time off</h2>
          <p className="muted small">For sick days reported by phone, missions, agreed late starts and so on.</p>
          <TimeOffForm me={me} people={people} onSaved={load} />
        </section>
      )}
      {(tab === 'inbox' || tab === 'all') && (
        <section className="card">
          <Msg msg={msg} />
          {!rows ? (
            <p className="muted">Loading…</p>
          ) : list.length === 0 ? (
            <p className="muted">{tab === 'inbox' ? 'Nothing waiting for you.' : 'No time off yet.'}</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Person</th>
                    <th>Type</th>
                    <th>When</th>
                    <th>Status</th>
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((t) => (
                    <tr key={t.id}>
                      <td>
                        {t.name}
                        {t.reason && <div className="muted small">“{t.reason}”</div>}
                      </td>
                      <td>
                        {t.typeLabel}
                        <div className="muted small">{days(t.workingDays)}</div>
                      </td>
                      <td>
                        <Range t={t} />
                      </td>
                      <td>
                        <TimeOffStatus status={t.status} />
                        {t.decidedBy && t.status !== 'pending' && (
                          <div className="muted small">
                            {t.requestedBy === t.decidedBy && t.status === 'approved' ? 'recorded' : t.status} by {t.decidedBy}
                          </div>
                        )}
                        {t.decisionNote && <div className="muted small">“{t.decisionNote}”</div>}
                      </td>
                      <td className="actions">
                        {t.status === 'pending' && (
                          <>
                            <button className="primary" onClick={() => run(() => api(`/team/time-off/${t.id}/decide`, { method: 'POST', body: { decision: 'approve' } }))}>
                              Approve
                            </button>
                            <button onClick={() => setDeciding(t)}>Decline</button>
                          </>
                        )}
                        {t.status === 'approved' && t.endDate >= me.todayDate && (
                          <button className="danger" onClick={() => window.confirm(`Cancel ${t.name}'s ${t.typeLabel.toLowerCase()}?`) && run(() => api(`/team/time-off/${t.id}/cancel`, { method: 'POST' }))}>
                            Cancel
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
      {deciding && <DeclineDialog t={deciding} onClose={() => setDeciding(null)} onDone={load} />}
    </div>
  );
}

function DeclineDialog({ t, onClose, onDone }) {
  const [note, setNote] = useState('');
  const { msg, busy, run } = useRunner(onDone);
  return (
    <Modal title={`Decline ${t.name}'s request`} onClose={onClose}>
      <p className="muted small no-margin">
        {t.typeLabel}, {t.summary}. The reason is emailed to {t.name}.
      </p>
      <form
        className="stack-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await run(() => api(`/team/time-off/${t.id}/decide`, { method: 'POST', body: { decision: 'decline', note } }))) onClose();
        }}
      >
        <label>
          Reason
          <input value={note} onChange={(e) => setNote(e.target.value)} minLength={3} maxLength={500} required autoFocus />
        </label>
        <div className="row">
          <button className="primary" disabled={busy}>
            Decline request
          </button>
          <button type="button" onClick={onClose}>
            Keep it pending
          </button>
        </div>
        <Msg msg={msg} />
      </form>
    </Modal>
  );
}
