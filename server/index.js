import express from 'express';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, tx, getSettings, saveSettings, seedOwner, normalizeCode, logEvent, DEFAULT_SETTINGS } from './db.js';
import { localParts, toMinutes, formatTime, formatDuration, haversine, isValidTimeZone } from './time.js';
import { sendMail, alertRecipients, smtpConfigured } from './mailer.js';
import { startScheduler } from './scheduler.js';
import { buildReport, displayCell, exportReport, reportFileName } from './reports.js';
import { UPLOAD_DIR, saveImage, removeFile } from './media.js';
import {
  HttpError,
  authRouter,
  requireAuth,
  requireAdmin,
  requireOwner,
  requireInstitution,
  publicUser,
  publicInstitution,
  validatePassword,
  sendPasswordLink,
  issueSupportSession,
} from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4000);

seedOwner();

const app = express();
app.set('trust proxy', 1); // Render and most hosts sit behind one proxy
app.use(express.json());

// Uploaded logos and photos. Names are random and change on every upload, so they can be cached forever.
app.use(
  '/media',
  express.static(UPLOAD_DIR, {
    immutable: true,
    maxAge: '365d',
    index: false,
    setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
  }),
  (_req, res) => res.status(404).end(),
);

app.use('/api/auth', authRouter);

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
      `You are about ${Math.round(distance)} m away from ${s.officeName}. You must be within ${s.radiusMeters} m to do this.`,
    );
  }
  return { lat, lng, accuracy, distance: Math.round(distance) };
}

const todayRecord = (userId, date) =>
  db.prepare('SELECT * FROM attendance WHERE user_id = ? AND date = ?').get(userId, date);

function noSupport(req, _res, next) {
  if (req.user.support) throw new HttpError(403, "Support sessions can't check in or out.");
  next();
}

// ---------------------------------------------------------------- me / employee

app.get('/api/me', requireAuth, (req, res) => {
  if (!req.inst) return res.json({ user: publicUser(req.user), institution: null });
  const s = getSettings(req.inst.id);
  const now = localParts(new Date(), s.timezone);
  const recent = req.user.support
    ? []
    : db.prepare('SELECT * FROM attendance WHERE user_id = ? ORDER BY date DESC LIMIT 14').all(req.user.id);
  res.json({
    user: publicUser(req.user),
    support: Boolean(req.user.support),
    institution: publicInstitution(req.inst),
    today: req.user.support ? null : todayRecord(req.user.id, now.date) || null,
    todayDate: now.date,
    isWorkDay: s.workDays.includes(now.weekday),
    settings: publicSettings(s),
    recent,
  });
});

app.post('/api/attendance/check-in', requireAuth, requireInstitution, noSupport, (req, res) => {
  const s = getSettings(req.inst.id);
  const loc = verifyLocation(req.body, s);
  const nowDate = new Date();
  const now = localParts(nowDate, s.timezone);

  const existing = todayRecord(req.user.id, now.date);
  if (existing) {
    throw new HttpError(409, `You already checked in today at ${formatTime(existing.check_in_at, s.timezone)}.`);
  }

  const start = toMinutes(s.workStart);
  const late = s.workDays.includes(now.weekday) && now.minutes > start + s.graceMinutes;
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
    sendMail({
      to,
      brand: req.inst,
      subject: `Late check-in: ${req.user.name} (${formatDuration(lateMinutes)} late)`,
      text:
        `${req.user.name} <${req.user.email}> checked in late.\n\n` +
        `Date:        ${now.date}\n` +
        `Checked in:  ${time}\n` +
        `Start time:  ${s.workStart} (grace period ${s.graceMinutes} min)\n` +
        `Late by:     ${formatDuration(lateMinutes)}\n` +
        `Location:    ${loc.distance} m from ${s.officeName}\n`,
    });
  }

  res.json({
    record: todayRecord(req.user.id, now.date),
    message: late
      ? `Checked in at ${time}. You are ${formatDuration(lateMinutes)} late; your manager has been notified.`
      : `Checked in at ${time}. Have a good day!`,
  });
});

app.post('/api/attendance/check-out', requireAuth, requireInstitution, noSupport, (req, res) => {
  const s = getSettings(req.inst.id);
  const loc = verifyLocation(req.body, s);
  const nowDate = new Date();
  const now = localParts(nowDate, s.timezone);

  const record = todayRecord(req.user.id, now.date);
  if (!record) throw new HttpError(409, 'You have not checked in today.');
  if (record.check_out_at) {
    throw new HttpError(409, `You already checked out at ${formatTime(record.check_out_at, s.timezone)}.`);
  }

  const end = toMinutes(s.workEnd);
  const early = s.workDays.includes(now.weekday) && now.minutes < end;
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
      brand: req.inst,
      subject: `Early check-out: ${req.user.name} (${formatDuration(earlyMinutes)} early)`,
      text:
        `${req.user.name} <${req.user.email}> checked out before the end of the work day.\n\n` +
        `Date:         ${now.date}\n` +
        `Checked in:   ${formatTime(record.check_in_at, s.timezone)}\n` +
        `Checked out:  ${time}\n` +
        `End time:     ${s.workEnd}\n` +
        `Early by:     ${formatDuration(earlyMinutes)}\n`,
    });
  }

  res.json({
    record: todayRecord(req.user.id, now.date),
    message: early
      ? `Checked out at ${time}, ${formatDuration(earlyMinutes)} before ${s.workEnd}.`
      : `Checked out at ${time}. See you tomorrow!`,
  });
});

// ---------------------------------------------------------------- institution admin

const admin = express.Router();
admin.use(requireAuth, requireAdmin);

admin.get('/attendance', (req, res) => {
  const s = getSettings(req.inst.id);
  const today = localParts(new Date(), s.timezone).date;
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const from = dateRe.test(req.query.from) ? req.query.from : today;
  const to = dateRe.test(req.query.to) ? req.query.to : from;

  let rows;
  if (from === to) {
    rows = db
      .prepare(
        `SELECT u.id AS user_id, u.name, u.email, u.role, ? AS date,
                a.id, a.check_in_at, a.check_in_distance, a.late, a.late_minutes,
                a.check_out_at, a.check_out_distance, a.early, a.early_minutes
         FROM users u
         LEFT JOIN attendance a ON a.user_id = u.id AND a.date = ?
         WHERE u.institution_id = ? AND (u.active = 1 OR a.id IS NOT NULL)
         ORDER BY u.name COLLATE NOCASE`,
      )
      .all(from, from, req.inst.id);
  } else {
    rows = db
      .prepare(
        `SELECT a.*, u.name, u.email, u.role FROM attendance a
         JOIN users u ON u.id = a.user_id
         WHERE u.institution_id = ? AND a.date BETWEEN ? AND ?
         ORDER BY a.date DESC, u.name COLLATE NOCASE`,
      )
      .all(req.inst.id, from, to);
  }
  res.json({ from, to, rows });
});

const userInInstitution = (req) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND institution_id = ?').get(Number(req.params.id), req.inst.id);
  if (!user) throw new HttpError(404, 'User not found.');
  return user;
};

admin.get('/users', (req, res) => {
  res.json(db.prepare('SELECT * FROM users WHERE institution_id = ? ORDER BY name COLLATE NOCASE').all(req.inst.id).map(publicUser));
});

admin.post('/users', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const role = req.body.role === 'admin' ? 'admin' : 'employee';
  const password = req.body.password ? String(req.body.password) : '';
  if (!name) throw new HttpError(400, 'Name is required.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'A valid email is required.');
  if (password) validatePassword(password);
  if (db.prepare('SELECT 1 FROM users WHERE institution_id = ? AND email = ?').get(req.inst.id, email)) {
    throw new HttpError(409, 'Someone with that email already exists.');
  }
  const { lastInsertRowid } = db
    .prepare('INSERT INTO users (institution_id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)')
    .run(req.inst.id, name, email, password ? bcrypt.hashSync(password, 10) : null, role);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
  let message = `${name} was added.`;
  if (!password) {
    const r = await sendPasswordLink(req, user, req.inst, 'invite');
    message = r.sent || !smtpConfigured ? `${name} was added and invited by email.` : `${name} was added, but the invite email failed: ${r.error}`;
  }
  res.status(201).json({ user: publicUser(user), message });
});

admin.post('/users/:id/invite', async (req, res) => {
  const user = userInInstitution(req);
  const r = await sendPasswordLink(req, user, req.inst, user.password_hash ? 'reset' : 'invite');
  if (!r.sent && smtpConfigured) throw new HttpError(502, `Sending failed: ${r.error}`);
  res.json({ message: user.password_hash ? `Password reset link sent to ${user.email}.` : `Invite sent again to ${user.email}.` });
});

admin.patch('/users/:id', (req, res) => {
  const user = userInInstitution(req);
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
    db.prepare('UPDATE users SET active = ?, token_version = token_version + 1 WHERE id = ?').run(req.body.active ? 1 : 0, user.id);
  }
  if (req.body.password !== undefined) {
    validatePassword(req.body.password);
    db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(
      bcrypt.hashSync(req.body.password, 10),
      user.id,
    );
  }
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)));
});

admin.get('/settings', (req, res) => {
  res.json({ settings: getSettings(req.inst.id), smtpConfigured });
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
  num('trustDays', 1, 365);
  num('codeMinutes', 2, 60);
  num('resetMinutes', 5, 1440);
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
  for (const k of ['emailEmployee', 'notifyEarlyCheckout', 'notifyNoShow', 'weeklyReport', 'require2fa']) {
    if (b[k] !== undefined) out[k] = Boolean(b[k]);
  }

  const merged = { ...getSettings(req.inst.id), ...out };
  if (toMinutes(merged.workEnd) <= toMinutes(merged.workStart)) {
    throw new HttpError(400, 'End time must be after start time.');
  }
  if (b.require2fa !== undefined && !out.require2fa) {
    logEvent(req.inst.id, req.user.id, 'setting', `${req.user.name} turned off email codes for new devices.`);
  }
  res.json({ settings: saveSettings(req.inst.id, out), smtpConfigured });
});

admin.post('/test-email', async (req, res) => {
  const s = getSettings(req.inst.id);
  const to = alertRecipients(s);
  if (to.length === 0) throw new HttpError(400, 'Add at least one alert email in Settings first.');
  const result = await sendMail({
    to,
    brand: req.inst,
    subject: 'Check-in system: test email',
    text: `This is a test email from the ${req.inst.name} check-in system, requested by ${req.user.name}.`,
  });
  if (result.sent) return res.json({ message: `Test email sent to ${to.join(', ')}.` });
  if (!smtpConfigured) {
    return res.json({ message: 'SMTP is not configured; the email was printed in the server console instead.' });
  }
  throw new HttpError(502, `Sending failed: ${result.error}. Check the SMTP settings and the server logs.`);
});

// Security & devices
admin.get('/security', (req, res) => {
  const devices = db
    .prepare(
      `SELECT t.id, t.label, t.created_at, t.last_used_at, u.name, u.email FROM tokens t
       JOIN users u ON u.id = t.user_id
       WHERE u.institution_id = ? AND t.kind = 'device' AND t.expires_at > ?
       ORDER BY t.last_used_at DESC`,
    )
    .all(req.inst.id, new Date().toISOString());
  const events = db
    .prepare('SELECT kind, detail, created_at FROM security_events WHERE institution_id = ? ORDER BY id DESC LIMIT 30')
    .all(req.inst.id);
  res.json({ devices, events });
});

admin.delete('/devices/:id', (req, res) => {
  const row = db
    .prepare(
      `SELECT t.id, t.label, u.name FROM tokens t JOIN users u ON u.id = t.user_id
       WHERE t.id = ? AND t.kind = 'device' AND u.institution_id = ?`,
    )
    .get(Number(req.params.id), req.inst.id);
  if (!row) throw new HttpError(404, 'Device not found.');
  db.prepare('DELETE FROM tokens WHERE id = ?').run(row.id);
  logEvent(req.inst.id, req.user.id, 'device_removed', `${req.user.name} removed ${row.name}'s ${row.label}.`);
  res.json({ message: `Removed ${row.name}'s ${row.label}.` });
});

admin.post('/devices/forget-all', (req, res) => {
  const r = db
    .prepare("DELETE FROM tokens WHERE kind = 'device' AND user_id IN (SELECT id FROM users WHERE institution_id = ?)")
    .run(req.inst.id);
  logEvent(req.inst.id, req.user.id, 'device_removed', `${req.user.name} removed all trusted devices (${r.changes}).`);
  res.json({ message: `Removed ${r.changes} trusted device(s).` });
});

// Reports
function reportFromQuery(req, q) {
  const s = getSettings(req.inst.id);
  try {
    return buildReport(req.inst, s, { type: q.type, from: q.from, to: q.to, userId: q.userId || null });
  } catch (err) {
    throw new HttpError(err.status || 500, err.message);
  }
}

admin.get('/reports', async (req, res) => {
  const report = reportFromQuery(req, req.query);
  const format = req.query.format;
  if (['csv', 'xlsx', 'pdf'].includes(format)) {
    const file = await exportReport(report, format, req.user.name);
    res.setHeader('Content-Type', file.type);
    res.setHeader('Content-Disposition', `attachment; filename="${reportFileName(report, file.ext)}"`);
    return res.send(file.buffer);
  }
  const limit = 50;
  res.json({
    title: report.title,
    period: report.period,
    workDayCount: report.workDayCount,
    stats: report.stats,
    columns: report.columns.map(({ key, label, type }) => ({ key, label, type })),
    total: report.rows.length,
    rows: report.rows.slice(0, limit).map((r) => Object.fromEntries(report.columns.map((c) => [c.key, displayCell(c, r[c.key])]))),
  });
});

admin.post('/reports/email', async (req, res) => {
  const report = reportFromQuery(req, req.body);
  const format = ['csv', 'xlsx', 'pdf'].includes(req.body.format) ? req.body.format : 'xlsx';
  const file = await exportReport(report, format, req.user.name);
  const result = await sendMail({
    to: [req.user.email],
    brand: req.inst,
    subject: `${report.title}: ${report.period}`,
    text: `Attached is the ${report.title.toLowerCase()} report for ${req.inst.name}, ${report.period}.\n`,
    attachments: [{ filename: reportFileName(report, file.ext), content: file.buffer }],
  });
  if (!result.sent && smtpConfigured) throw new HttpError(502, `Sending failed: ${result.error}`);
  res.json({ message: smtpConfigured ? `Report sent to ${req.user.email}.` : 'SMTP is not configured; the email was printed in the server console.' });
});

// Branding (logo + login photo)
const reloadInst = (id) => db.prepare('SELECT * FROM institutions WHERE id = ?').get(id);
const brandingOf = (inst) => {
  const p = publicInstitution(inst);
  return { logoUrl: p.logoUrl, photoUrl: p.photoUrl, photoFocus: p.photoFocus, photoDim: p.photoDim };
};
const rawImage = express.raw({ type: ['image/png', 'image/jpeg'], limit: '4mb' });

admin.get('/branding', (req, res) => res.json(brandingOf(req.inst)));

for (const kind of ['logo', 'photo']) {
  const column = `${kind}_file`;

  admin.put(`/branding/${kind}`, rawImage, (req, res) => {
    const saved = saveImage(req.inst.id, kind, req.body);
    if (saved.error) throw new HttpError(400, saved.error);
    const old = req.inst[column];
    db.prepare(`UPDATE institutions SET ${column} = ? WHERE id = ?`).run(saved.name, req.inst.id);
    removeFile(old);
    logEvent(req.inst.id, req.user.id, 'branding', `${req.user.name} uploaded a new ${kind === 'logo' ? 'logo' : 'login photo'}.`);
    res.json(brandingOf(reloadInst(req.inst.id)));
  });

  admin.delete(`/branding/${kind}`, (req, res) => {
    removeFile(req.inst[column]);
    db.prepare(`UPDATE institutions SET ${column} = NULL WHERE id = ?`).run(req.inst.id);
    logEvent(req.inst.id, req.user.id, 'branding', `${req.user.name} removed the ${kind === 'logo' ? 'logo' : 'login photo'}.`);
    res.json(brandingOf(reloadInst(req.inst.id)));
  });
}

admin.patch('/branding', (req, res) => {
  const pct = (v, name) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 100) throw new HttpError(400, `${name} must be between 0 and 100.`);
    return Math.round(n * 10) / 10;
  };
  const inst = req.inst;
  const x = req.body.focusX === undefined ? inst.photo_focus_x : pct(req.body.focusX, 'focusX');
  const y = req.body.focusY === undefined ? inst.photo_focus_y : pct(req.body.focusY, 'focusY');
  const dim = req.body.dim === undefined ? inst.photo_dim : req.body.dim ? 1 : 0;
  db.prepare('UPDATE institutions SET photo_focus_x = ?, photo_focus_y = ?, photo_dim = ? WHERE id = ?').run(x, y, dim, inst.id);
  res.json(brandingOf(reloadInst(inst.id)));
});

app.use('/api/admin', admin);

// ---------------------------------------------------------------- platform owner

const platform = express.Router();
platform.use(requireAuth, requireOwner);
const RESERVED_CODES = new Set(['platform', 'api', 'assets', 'admin', 'login', 'reset', 'forgot']);

platform.get('/institutions', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT i.*,
              (SELECT COUNT(*) FROM users u WHERE u.institution_id = i.id AND u.active = 1) AS people,
              (SELECT COUNT(*) FROM users u WHERE u.institution_id = i.id AND u.role = 'admin' AND u.password_hash IS NOT NULL) AS ready_admins
       FROM institutions i ORDER BY i.name COLLATE NOCASE`,
    )
    .all();
  res.json(
    rows.map((i) => ({
      ...publicInstitution(i),
      people: i.people,
      invitePending: i.ready_admins === 0,
      timezone: getSettings(i.id).timezone,
      createdAt: i.created_at,
    })),
  );
});

platform.post('/institutions', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const code = normalizeCode(req.body.code);
  const timezone = String(req.body.timezone || 'UTC');
  const adminName = String(req.body.adminName || '').trim();
  const adminEmail = String(req.body.adminEmail || '').trim().toLowerCase();
  if (!name) throw new HttpError(400, 'Institution name is required.');
  if (code.length < 2 || code.length > 40) throw new HttpError(400, 'Short code must be 2 to 40 letters, numbers or dashes.');
  if (RESERVED_CODES.has(code)) throw new HttpError(400, `"${code}" is reserved. Choose another short code.`);
  if (db.prepare('SELECT 1 FROM institutions WHERE code = ?').get(code)) throw new HttpError(409, 'That short code is already taken.');
  if (!isValidTimeZone(timezone)) throw new HttpError(400, 'Unknown timezone.');
  if (!adminName) throw new HttpError(400, "First admin's name is required.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail)) throw new HttpError(400, "A valid email for the first admin is required.");

  const { inst, user } = tx(() => {
    const id = Number(db.prepare('INSERT INTO institutions (name, code) VALUES (?, ?)').run(name, code).lastInsertRowid);
    saveSettings(id, { timezone });
    const uid = db
      .prepare("INSERT INTO users (institution_id, name, email, password_hash, role) VALUES (?, ?, ?, NULL, 'admin')")
      .run(id, adminName, adminEmail).lastInsertRowid;
    return {
      inst: db.prepare('SELECT * FROM institutions WHERE id = ?').get(id),
      user: db.prepare('SELECT * FROM users WHERE id = ?').get(uid),
    };
  });
  logEvent(inst.id, req.user.id, 'created', `Institution created by the platform owner. Invite sent to ${adminEmail}.`);
  const r = await sendPasswordLink(req, user, inst, 'invite');
  res.status(201).json({
    institution: publicInstitution(inst),
    message:
      r.sent || !smtpConfigured
        ? `${name} was created and ${adminEmail} was invited.`
        : `${name} was created, but the invite email failed: ${r.error}`,
  });
});

const institutionParam = (req) => {
  const inst = db.prepare('SELECT * FROM institutions WHERE id = ?').get(Number(req.params.id));
  if (!inst) throw new HttpError(404, 'Institution not found.');
  return inst;
};

platform.patch('/institutions/:id', (req, res) => {
  const inst = institutionParam(req);
  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) throw new HttpError(400, 'Name is required.');
    db.prepare('UPDATE institutions SET name = ? WHERE id = ?').run(name, inst.id);
  }
  if (req.body.status !== undefined) {
    const status = req.body.status === 'suspended' ? 'suspended' : 'active';
    db.prepare('UPDATE institutions SET status = ? WHERE id = ?').run(status, inst.id);
    logEvent(inst.id, req.user.id, status, `Institution ${status === 'suspended' ? 'suspended' : 'reactivated'} by the platform owner.`);
  }
  res.json(publicInstitution(db.prepare('SELECT * FROM institutions WHERE id = ?').get(inst.id)));
});

platform.post('/institutions/:id/invite', async (req, res) => {
  const inst = institutionParam(req);
  const pending = db
    .prepare("SELECT * FROM users WHERE institution_id = ? AND role = 'admin' AND password_hash IS NULL ORDER BY id")
    .all(inst.id);
  if (pending.length === 0) throw new HttpError(400, 'Every admin here has already set a password.');
  for (const u of pending) await sendPasswordLink(req, u, inst, 'invite');
  res.json({ message: `Invite sent again to ${pending.map((u) => u.email).join(', ')}.` });
});

platform.post('/institutions/:id/support', (req, res) => {
  const inst = institutionParam(req);
  logEvent(inst.id, req.user.id, 'support_access', 'Platform owner opened this institution to help (support access).');
  res.json(issueSupportSession(req.user, inst));
});

app.use('/api/platform', platform);

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
