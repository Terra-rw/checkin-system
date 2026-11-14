// Small shared UI pieces: modal dialog, stat tile, attendance status badges, async message helper.
import { useEffect, useRef, useState } from 'react';
import { formatDuration } from '../api.js';

/** Native <dialog> as a modal. Closes on Escape and backdrop click. */
export function Modal({ title, onClose, children, wide = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.open && d.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? 'wide' : ''}`}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => e.target === ref.current && onClose()}
    >
      <div className="modal-body stack-sm">
        <div className="section-head">
          <h2 className="h3 no-margin">{title}</h2>
          <button className="link" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

export function Stat({ label, value, tone = '' }) {
  return (
    <div className={`stat ${tone}`}>
      <div className="value">{value}</div>
      <div className="label">{label}</div>
    </div>
  );
}

/**
 * Badges for one attendance row. Understands the team/attendance `status` and `plan`
 * (not expected, not in yet, no check-out) and falls back to plain records (My day history).
 */
export function StatusBadges({ r }) {
  if (!r) return null;
  const status = r.status || (r.check_in_at ? 'present' : 'absent');
  if (status === 'not_expected') return <span className="badge blue">{r.plan?.label || 'Not expected'}</span>;
  if (status === 'not_yet') return <span className="badge">Not in yet</span>;
  if (status === 'absent') return <span className="badge red">Absent</span>;
  const notExpected = r.plan && !r.plan.expected;
  return (
    <>
      {r.late ? (
        <span className="badge amber">Late {formatDuration(r.late_minutes)}</span>
      ) : notExpected ? (
        <span className="badge blue">Worked · {r.plan.label}</span>
      ) : (
        <span className="badge green">On time</span>
      )}
      {r.early ? <span className="badge amber">Left {formatDuration(r.early_minutes)} early</span> : null}
      {status === 'no_checkout' && <span className="badge red">No check-out</span>}
      {r.edited && <span className="badge">Edited</span>}
    </>
  );
}

export function TimeOffStatus({ status }) {
  const tone = { pending: 'amber', approved: 'green', declined: 'red', cancelled: '' }[status] ?? '';
  const label = { pending: 'Waiting for approval', approved: 'Approved', declined: 'Declined', cancelled: 'Cancelled' }[status] || status;
  return <span className={`badge ${tone}`}>{label}</span>;
}

/** `run(fn)` shows the result message (or error) and returns true on success. */
export function useRunner(after) {
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn, success) => {
    setMsg(null);
    setBusy(true);
    try {
      const result = await fn();
      if (after) await after();
      setMsg({ type: 'success', text: result?.message || success || 'Saved.' });
      return result || true;
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { msg, setMsg, busy, run };
}

export const Msg = ({ msg }) => (msg ? <div className={`alert ${msg.type}`} role={msg.type === 'error' ? 'alert' : 'status'}>{msg.text}</div> : null);
