import { initials } from '../api.js';

/**
 * An institution's logo, or its initials when it has none.
 * `size` is the square size in px; `tile` puts the logo on a white rounded tile (for photos and dark areas).
 */
export default function Logo({ inst, size = 28, tile = false, className = '' }) {
  const style = { width: size, height: size, ...(tile ? { padding: Math.round(size * 0.14) } : null) };
  if (inst?.logoUrl) {
    return (
      <span className={`inst-logo ${tile ? 'tile' : ''} ${className}`} style={style}>
        <img src={inst.logoUrl} alt={`${inst.name} logo`} />
      </span>
    );
  }
  return (
    <span className={`logo ${className}`} style={{ ...style, fontSize: Math.max(11, Math.round(size * 0.36)), borderRadius: Math.round(size * 0.27) }} aria-hidden="true">
      {initials(inst?.name)}
    </span>
  );
}

/** Background style for an institution photo, honouring its focus point. */
export function photoStyle(inst) {
  if (!inst?.photoUrl) return null;
  return {
    backgroundImage: `url("${inst.photoUrl}")`,
    backgroundPosition: `${inst.photoFocus?.x ?? 50}% ${inst.photoFocus?.y ?? 50}%`,
  };
}
