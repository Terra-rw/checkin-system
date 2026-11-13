import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, getSettings, saveSettings, seedAdmin, DEFAULT_SETTINGS } from './db.js';
import { localParts, toMinutes, formatTime, haversine, isValidTimeZone } from './time.js';
import { sendMail, alertRecipients, smtpConfigured } from './mailer.js';
import { startScheduler } from './scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4000);

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.warn('[auth] JWT_SECRET not set: using a random one (everyone is logged out on restart).');
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
}

seedAdmin();

const app = express();
app.use(express.json());

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------- auth

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, active: !!u.active });

function requireAuth(req, _res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    throw new HttpError(401, 'Please log in.');
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
  if (!user || !user.active) throw new HttpError(401, 'Your account is disabled.');
  req.user = user;
  next();
}

function requireAdmin(req, _res, next) {
  if (req.user.role !== 'admin') throw new HttpError(403, 'Admins only.');
  next();
}

app.post('/api/auth/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(String(req.body.password || ''), user.password_hash)) {
    throw new HttpError(401, 'Wrong email or password.');
  }
  if (!user.active) throw new HttpError(403, 'Your account is disabled.');
  const token = jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: publicUser(user) });
});

// ---------------------------------------------------------------- helpers

/** Settings an employee is allowed to see. */
function publicSettings(s) {
  return {
    officeName: s.officeName,
    officeConfigured: s.officeLat != null && s.officeLng != null,
    radiusMeters: s.radiusMeters,
    workStart: s.workStart,
    workEnd: s.workEnd,
    graceMinutes: s.graceMinutes,
    workDays: s.workDays,
    timezone: s.timezone,
  };
}

/** Validates a submitted GPS fix against the office geofence. */
function verifyLocation(body, s) {
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  const accuracy = Number(body.accuracy);

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new HttpError(400, 'Your location is required to check in.');
  }
  if (s.officeLat == null || s.officeLng == null) {
    throw new HttpError(400, 'The office location has not been set yet. Ask an admin to configure it.');
  }
  if (!Number.isFinite(accuracy) || accuracy > s.maxAccuracyMeters) {
    throw new HttpError(
      400,
      `Your GPS signal is not precise enough (±${Math.round(accuracy) || '?'} m, need ±${s.maxAccuracyMeters} m). ` +
        'Turn on precise location, step outside or near a window, and try again.',
    );
  }

  const distance = haversine(lat, lng, s.officeLat, s.officeLng);
  if (distance > s.radiusMeters) {
    throw new HttpError(
      403,
      `You are about ${Math.round(distance)} m away from ${s.officeName}. ` +
        `You must be within ${s.radiusMeters} m to do this.`,
    );
  }
  return { lat, lng, accuracy, distance: Math.round(distance) };
}

const todayRecord = (userId, date) =>
  db.prepare('SELECT * FROM attendance WHERE user_id = ? AND date = ?').get(userId, date);

// ---------------------------------------------------------------- employee

app.get('/api/me', requireAuth, (req, res) => {
  const s = getSettings();
  const now = localParts(new Date(), s.timezone);
  const recent = db
    .prepare('SELECT * FROM attendance WHERE user_id = ? ORDER BY date DESC LIMIT 14')
    .all(req.user.id);
  res.json({
    user: publicUser(req.user),
    today: todayRecord(req.user.id, now.date) || null,
    todayDate: now.date,
    isWorkDay: s.workDays.includes(now.weekday),
    settings: publicSettings(s),
    recent,
  });
});

app.post('/api/attendance/check-in', requireAuth, (req, res) => {
  const s = getSettings();
  const loc = verifyLocation(req.body, s);
  const nowDate = new Date();
  const now = localParts(nowDate, s.timezone);

  const existing = todayRecord(req.user.id, now.date);
  if (existing) {
    throw new HttpError(409, `You already checked in today at ${formatTime(existing.check_in_at, s.timezone)}.`);
  }

  const start = toMinutes(s.workStart);
  const isWorkDay = s.workDays.includes(now.weekday);
  const late = isWorkDay && now.minutes > start + s.graceMinutes;
  const lateMinutes = late ? now.minutes - start : 0;

  db.prepare(
    `INSERT INTO attendance (user_id, date, check_in_at, check_in_lat, check_in_lng, check_in_distance,
                             check_in_accuracy, late, late_minutes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(req.user.id, now.date, nowDate.toISOString(), loc.lat, loc.lng, loc.distance, loc.accuracy, late ? 1 : 0, lateMinutes);

  const time = formatTime(nowDate, s.timezone);
  if (late) {
    const to = alertRecipients(s);
    if (s.emailEmployee) to.push(req.user.email);
    // Fire-and-forget so a slow mail server doesn't delay the check-in.
    sendMail({
      to,
      subject: `Late check-in: ${req.user.name} (${lateMinutes} min late)`,
      text:
        `${req.user.name} <${req.user.email}> checked in late.\n\n` +
        `Date:        ${now.date}\n` +
        `Checked in:  ${time}\n` +
        `Start time:  ${s.workStart} (grace period ${s.graceMinutes} min)\n` +
        `Late by:     ${lateMinutes} minutes\n` +
        `Location:    ${loc.distance} m from ${s.officeName}\n`,
    });
  }

  res.json({
    record: todayRecord(req.user.id, now.date),
    message: late
      ? `Checked in at ${time}. You are ${lateMinutes} minutes late; your manager has been notified.`
      : `Checked in at ${time}. Have a good day!`,
  });
});

app.post('/api/attendance/check-out', requireAuth, (req, res) => {
  const s = getSettings();
  const loc = verifyLocation(req.body, s);
  const nowDate = new Date();
  const now = localParts(nowDate, s.timezone);

  const record = todayRecord(req.user.id, now.date);
  if (!record) throw new HttpError(409, 'You have not checked in today.');
  if (record.check_out_at) {
    throw new HttpError(409, `You already checked out at ${formatTime(record.check_out_at, s.timezone)}.`);
  }

  const end = toMinutes(s.workEnd);
  const isWorkDay = s.workDays.includes(now.weekday);
  const early = isWorkDay && now.minutes < end;
  const earlyMinutes = early ? end - now.minutes : 0;

  db.prepare(
    `UPDATE attendance SET check_out_at = ?, check_out_lat = ?, check_out_lng = ?, check_out_distance = ?,
                           check_out_accuracy = ?, early = ?, early_minutes = ?
     WHERE id = ?`,
  ).run(nowDate.toISOString(), loc.lat, loc.lng, loc.distance, loc.accuracy, early ? 1 : 0, earlyMinutes, record.id);

  const time = formatTime(nowDate, s.timezone);
  if (early && s.notifyEarlyCheckout) {
    const to = alertRecipients(s);
    if (s.emailEmployee) to.push(req.user.email);
    sendMail({
      to,
      subject: `Early check-out: ${req.user.name} (${earlyMinutes} min early)`,
      text:
        `${req.user.name} <${req.user.email}> checked out before the end of the work day.\n\n` +
        `Date:         ${now.date}\n` +
        `Checked in:   ${formatTime(record.check_in_at, s.timezone)}\n` +
        `Checked out:  ${time}\n` +
        `End time:     ${s.workEnd}\n` +
        `Early by:     ${earlyMinutes} minutes\n`,
    });
  }

  res.json({
    record: todayRecord(req.user.id, now.date),
    message: early
      ? `Checked out at ${time}, ${earlyMinutes} minutes before ${s.workEnd}.`
      : `Checked out at ${time}. See you tomorrow!`,
  });
});

// ---------------------------------------------------------------- admin

const admin = express.Router();
admin.use(requireAuth, requireAdmin);

admin.get('/attendance', (req, res) => {
  const s = getSettings();
  const today = localParts(new Date(), s.timezone).date;
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const from = dateRe.test(req.query.from) ? req.query.from : today;
  const to = dateRe.test(req.query.to) ? req.query.to : from;

  let rows;
  if (from === to) {
    // Single day: include active people with no record so absences are visible.
    rows = db
      .prepare(
        `SELECT u.id AS user_id, u.name, u.email, u.role, ? AS date,
                a.id, a.check_in_at, a.check_in_distance, a.late, a.late_minutes,
                a.check_out_at, a.check_out_distance, a.early, a.early_minutes
         FROM users u
         LEFT JOIN attendance a ON a.user_id = u.id AND a.date = ?
         WHERE u.active = 1 OR a.id IS NOT NULL
         ORDER BY u.name`,
      )
      .all(from, from);
  } else {
    rows = db
      .prepare(
        `SELECT a.*, u.name, u.email, u.role FROM attendance a
         JOIN users u ON u.id = a.user_id
         WHERE a.date BETWEEN ? AND ?
         ORDER BY a.date DESC, u.name`,
      )
      .all(from, to);
  }
  res.json({ from, to, rows });
});

admin.get('/users', (_req, res) => {
  res.json(db.prepare('SELECT * FROM users ORDER BY name').all().map(publicUser));
});

function validatePassword(p) {
  if (typeof p !== 'string' || p.length < 6) throw new HttpError(400, 'Password must be at least 6 characters.');
}

admin.post('/users', (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const role = req.body.role === 'admin' ? 'admin' : 'employee';
  if (!name) throw new HttpError(400, 'Name is required.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'A valid email is required.');
  validatePassword(req.body.password);
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    throw new HttpError(409, 'Someone with that email already exists.');
  }
  const { lastInsertRowid } = db
    .prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(name, email, bcrypt.hashSync(req.body.password, 10), role);
  res.status(201).json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid)));
});

admin.patch('/users/:id', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!user) throw new HttpError(404, 'User not found.');
  const isSelf = user.id === req.user.id;

  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) throw new HttpError(400, 'Name is required.');
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, user.id);
  }
  if (req.body.role !== undefined) {
    if (isSelf && req.body.role !== 'admin') throw new HttpError(400, "You can't remove your own admin role.");
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(req.body.role === 'admin' ? 'admin' : 'employee', user.id);
  }
  if (req.body.active !== undefined) {
    if (isSelf && !req.body.active) throw new HttpError(400, "You can't deactivate yourself.");
    db.prepare('UPDATE users SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, user.id);
  }
  if (req.body.password !== undefined) {
    validatePassword(req.body.password);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(req.body.password, 10), user.id);
  }
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)));
});

admin.get('/settings', (_req, res) => {
  res.json({ settings: getSettings(), smtpConfigured });
});

admin.put('/settings', (req, res) => {
  const b = req.body;
  const out = {};
  const num = (k, min, max) => {
    if (b[k] === undefined) return;
    const v = Number(b[k]);
    if (!Number.isFinite(v) || v < min || v > max) throw new HttpError(400, `${k} must be between ${min} and ${max}.`);
    out[k] = v;
  };
  const time = (k) => {
    if (b[k] === undefined) return;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(b[k])) throw new HttpError(400, `${k} must look like 08:00.`);
    out[k] = b[k];
  };

  if (b.officeName !== undefined) out.officeName = String(b.officeName).trim() || DEFAULT_SETTINGS.officeName;
  if (b.officeLat === null || b.officeLat === '') out.officeLat = null;
  else num('officeLat', -90, 90);
  if (b.officeLng === null || b.officeLng === '') out.officeLng = null;
  else num('officeLng', -180, 180);
  num('radiusMeters', 10, 10000);
  num('maxAccuracyMeters', 5, 5000);
  num('graceMinutes', 0, 240);
  time('workStart');
  time('workEnd');
  if (b.timezone !== undefined) {
    if (!isValidTimeZone(b.timezone)) throw new HttpError(400, 'Unknown timezone.');
    out.timezone = b.timezone;
  }
  if (b.workDays !== undefined) {
    if (!Array.isArray(b.workDays)) throw new HttpError(400, 'workDays must be a list.');
    out.workDays = [...new Set(b.workDays.map(Number).filter((d) => d >= 0 && d <= 6))].sort();
  }
  if (b.alertEmails !== undefined) out.alertEmails = String(b.alertEmails);
  for (const k of ['emailEmployee', 'notifyEarlyCheckout', 'notifyNoShow']) {
    if (b[k] !== undefined) out[k] = Boolean(b[k]);
  }

  const merged = { ...getSettings(), ...out };
  if (toMinutes(merged.workEnd) <= toMinutes(merged.workStart)) {
    throw new HttpError(400, 'End time must be after start time.');
  }
  res.json({ settings: saveSettings(out), smtpConfigured });
});

admin.post('/test-email', async (req, res) => {
  const s = getSettings();
  const to = alertRecipients(s);
  if (to.length === 0) throw new HttpError(400, 'Add at least one alert email in Settings first.');
  const sent = await sendMail({
    to,
    subject: 'Check-in system: test email',
    text: `This is a test email from the check-in system, requested by ${req.user.name}.`,
  });
  res.json({
    message: sent
      ? `Test email sent to ${to.join(', ')}.`
      : 'SMTP is not configured; the email was printed in the server console instead.',
  });
});

app.use('/api/admin', admin);

app.use('/api', (_req, _res) => {
  throw new HttpError(404, 'Not found.');
});

// ---------------------------------------------------------------- static client (production)

const clientDist = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('/{*splat}', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

// ---------------------------------------------------------------- errors

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'Something went wrong.' : err.message });
});

app.listen(PORT, () => {
  console.log(`Check-in server running on http://localhost:${PORT}`);
  startScheduler();
});
