import { initials } from '../../api.js';

/** Institution logo + name shown above every login-related screen. */
export default function AuthBrand({ scope, institution, compact = false }) {
  const isPlatform = scope === 'platform';
  const name = isPlatform ? 'Check-in platform' : institution?.name || scope;
  return (
    <div className={compact ? 'auth-brand compact' : 'auth-brand'}>
      <span className={compact ? 'logo' : 'logo big'}>{isPlatform ? '✓' : initials(name)}</span>
      <div>
        <div className="auth-name">{name}</div>
        {!compact && <div className="muted small">{window.location.host}/{scope}</div>}
      </div>
    </div>
  );
}
