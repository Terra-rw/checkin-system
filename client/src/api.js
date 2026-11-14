// ------------------------------------------------------------------ storage
// Sessions are kept per "scope": an institution code, or "platform" for the platform owner.
// localStorage can throw (private mode, blocked storage), so every access is guarded.

function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || '{}');
  } catch {
    return {};
  }
}
function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: the session just won't survive a reload */
  }
}

const SESSIONS = 'checkin_sessions';
const DEVICES = 'checkin_devices';
const LAST = 'checkin_last_institution';

export function getSession(scope) {
  return readJson(SESSIONS)[scope] || null;
}
export function setSession(scope, session) {
  const all = readJson(SESSIONS);
  if (session) all[scope] = session;
  else delete all[scope];
  writeJson(SESSIONS, all);
}

const deviceKey = (scope, email) => `${scope}|${String(email).trim().toLowerCase()}`;
export const getDeviceToken = (scope, email) => readJson(DEVICES)[deviceKey(scope, email)] || null;
export function setDeviceToken(scope, email, token) {
  const all = readJson(DEVICES);
  all[deviceKey(scope, email)] = token;
  writeJson(DEVICES, all);
}

export function getLastInstitution() {
  try {
    return localStorage.getItem(LAST);
  } catch {
    return null;
  }
}
export function setLastInstitution(code) {
  try {
    localStorage.setItem(LAST, code);
  } catch {
    /* ignore */
  }
}

// ------------------------------------------------------------------ routing

export function parseRoute() {
  const parts = window.location.pathname.split('/').filter(Boolean);
  const params = new URLSearchParams(window.location.search);
  if (parts.length === 0) return { page: 'home' };
  const scope = parts[0].toLowerCase();
  const sub = parts[1] || '';
  return { scope, page: sub || 'app', token: params.get('token') };
}

export function navigate(to) {
  window.history.pushState({}, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

// ------------------------------------------------------------------ requests

let currentScope = null;
export function setScope(scope) {
  currentScope = scope;
}

export async function api(path, { method = 'GET', body } = {}) {
  const token = currentScope && getSession(currentScope)?.token;
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token && !path.startsWith('/auth/')) {
    setSession(currentScope, null);
    window.location.reload();
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/** Downloads a file from an authenticated endpoint. */
export async function download(path) {
  const token = currentScope && getSession(currentScope)?.token;
  const res = await fetch(`/api${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Download failed (${res.status})`);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'report';
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return name;
}

/** Uploads an image blob as the raw request body. */
export async function uploadImage(path, blob) {
  const token = currentScope && getSession(currentScope)?.token;
  const res = await fetch(`/api${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': blob.type, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: blob,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || (res.status === 413 ? 'That image is too large.' : `Upload failed (${res.status})`));
  return data;
}

const IMAGE_RULES = {
  logo: { maxFile: 1, maxSide: 512, minSide: 128, type: 'image/png' },
  photo: { maxFile: 5, maxSide: 1920, minSide: 800, type: 'image/jpeg' },
};

/**
 * Checks a chosen file and shrinks it in the browser before upload:
 * logos become PNG (keeps transparency) at most 512 px, photos JPEG at most 1920 px.
 * Re-drawing also strips hidden metadata such as the GPS location in phone photos.
 */
export async function prepareImage(file, kind) {
  const rule = IMAGE_RULES[kind];
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Choose a PNG, JPG or WebP image.');
  if (file.size > rule.maxFile * 1024 * 1024) throw new Error(`That file is over ${rule.maxFile} MB. Choose a smaller one.`);

  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("That image couldn't be opened."));
      el.src = url;
    });
    const { naturalWidth: w, naturalHeight: h } = img;
    const shortSide = kind === 'logo' ? Math.min(w, h) : w;
    if (shortSide < rule.minSide) {
      throw new Error(kind === 'logo' ? `The logo is too small (${w} × ${h} px). Use at least ${rule.minSide} px.` : `The photo is too small (${w} px wide). Use at least ${rule.minSide} px.`);
    }
    const scale = Math.min(1, rule.maxSide / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext('2d');
    if (rule.type === 'image/jpeg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, rule.type, 0.85));
    if (!blob) throw new Error("That image couldn't be processed.");
    return { blob, previewUrl: URL.createObjectURL(blob), width: canvas.width, height: canvas.height, name: file.name };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ------------------------------------------------------------------ location

/** Asks the browser for a fresh, high-accuracy GPS fix. */
export function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('This browser does not support location services.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (err) => {
        const messages = {
          1: 'Location permission was denied. Allow location access for this site, then try again.',
          2: 'Your location is unavailable. Make sure location services are turned on.',
          3: 'Getting your location took too long. Please try again.',
        };
        reject(new Error(messages[err.code] || 'Could not get your location.'));
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    );
  });
}

// ------------------------------------------------------------------ formatting

export function formatTime(iso, timeZone) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(undefined, { timeZone, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

export function formatDateTime(iso, timeZone) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(undefined, { timeZone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

export function formatDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

/** 45 -> "45 min", 60 -> "1 hr", 85 -> "1 hr 25 min". */
export function formatDuration(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

/** "Example Academy" -> "EA", "NGA" -> "NG". */
export function initials(name) {
  const words = String(name || '?').split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return words
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
}

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
