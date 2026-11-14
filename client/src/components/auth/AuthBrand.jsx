import Logo, { photoStyle } from '../Logo.jsx';

/** Institution logo + name shown above every login-related screen. */
export default function AuthBrand({ scope, institution, compact = false }) {
  const isPlatform = scope === 'platform';
  const name = isPlatform ? 'Check-in platform' : institution?.name || scope;
  return (
    <div className={compact ? 'auth-brand compact' : 'auth-brand'}>
      {isPlatform ? (
        <span className={compact ? 'logo' : 'logo big'}>✓</span>
      ) : (
        <Logo inst={institution || { name }} size={compact ? 36 : 72} tile={Boolean(institution?.logoUrl)} />
      )}
      <div>
        <div className="auth-name">{name}</div>
        {!compact && <div className="auth-sub small">{window.location.host}/{scope}</div>}
      </div>
    </div>
  );
}

/** Wraps a login-style page; shows the institution's photo across the top when it has one. */
export function AuthPage({ institution, children }) {
  const style = photoStyle(institution);
  return (
    <div className={style ? 'center branded' : 'center'}>
      {style && <div className={`auth-photo ${institution.photoDim ? 'dim' : ''}`} style={style} aria-hidden="true" />}
      {children}
    </div>
  );
}
