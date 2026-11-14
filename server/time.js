// Time and distance helpers. All "local" values are computed in the
// timezone configured in settings, never the server's or the browser's clock.

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Creating an Intl.DateTimeFormat is slow (~50 µs) and memory-hungry, so build one per
// timezone and reuse it. Reports format two times per attendance row.
const formatterCache = new Map();
function formatter(kind, timeZone, options) {
  const key = `${kind}|${timeZone}`;
  let f = formatterCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(kind === 'parts' ? 'en-US' : 'en-GB', { timeZone, ...options });
    formatterCache.set(key, f);
  }
  return f;
}

/** Returns { date: 'YYYY-MM-DD', minutes: minutes since midnight, weekday: 0-6 } in `timeZone`. */
export function localParts(date, timeZone) {
  const parts = Object.fromEntries(
    formatter('parts', timeZone, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      weekday: 'short',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday],
  };
}

/** '08:30' -> 510 */
export function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

/** ISO timestamp -> '08:42' in `timeZone`. */
export function formatTime(iso, timeZone) {
  return formatter('time', timeZone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

export function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** 45 -> "45 min", 60 -> "1 hr", 85 -> "1 hr 25 min". */
export function formatDuration(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

/** 'YYYY-MM-DD' -> 0-6 (Sunday = 0). */
export function weekdayOf(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Inclusive list of 'YYYY-MM-DD' dates. */
export function dateRange(from, to) {
  const out = [];
  const [y, m, d] = from.split('-').map(Number);
  const cur = new Date(Date.UTC(y, m - 1, d));
  while (true) {
    const s = cur.toISOString().slice(0, 10);
    if (s > to) break;
    out.push(s);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

export function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

/** Great-circle distance in meters between two lat/lng points. */
export function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
