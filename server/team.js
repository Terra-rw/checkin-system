// Routes for managers and HR admins (/api/team) and employees' own time off (/api/time-off).
// Every /api/team query is limited by people.js scope: admins see the whole institution,
// managers only their direct reports. Admin-only routes stay in index.js under /api/admin.
import express from 'express';
import { db, tx, getSettings, logEvent } from './db.js';
import { HttpError, requireAuth, requireInstitution } from './auth.js';
import { localParts, toMinutes, formatTime, zonedTimeToUtc, dateRange } from './time.js';
import { sendMail, alertRecipients, smtpConfigured } from './mailer.js';
import { loadPlanContext, countWorkingDays, TIME_OFF_TYPES } from './schedule.js';
import { managerOf, scopeSql, userInScope, teamScope, latestTermsMap, contractSummary } from './people.js';
import { runReportJob } from './reportJobs.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const nowIso = () => new Date().toISOString();

function requireStaff(req, _res, next) {
  if (!req.inst || (req.user.role !== 'admin' && req.user.role !== 'manager')) throw new HttpError(403, 'Managers and admins only.');
  next();
}
function noSupport(req, _res, next) {
  if (req.user.support) throw new HttpError(403, "Support sessions can't do this.");
  next();
}

const minutesBetween = (a, b) => Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000));

// ---------------------------------------------------------------- shared time-off helpers

/** Validates a time-off body; returns normalised values. */
function parseTimeOff(b) {
  const type = String(b.type || '');
  if (!TIME_OFF_TYPES[type]) throw new HttpError(400, 'Choose a type of time off.');
  const start = String(b.startDate || '');
  const end = String(b.endDate || start);
  if (!DATE_RE.test(start) || !DATE_RE.test(end) || end < start) throw new HttpError(400, 'Choose valid dates (the end can’t be before the start).');
  if (dateRange(start, end).length > 366) throw new HttpError(400, 'Time off can be at most a year at a time.');
  let part = ['full', 'am', 'pm'].includes(b.part) ? b.part : 'full';
  let arriveBy = null;
  let leaveFrom = null;
  let weekdays = null;
  if (type === 'adjusted') {
    part = 'full';
    arriveBy = b.arriveBy ? String(b.arriveBy) : null;
    leaveFrom = b.leaveFrom ? String(b.leaveFrom) : null;
    if (!arriveBy && !leaveFrom) throw new HttpError(400, 'Set an arrival time, a leaving time, or both.');
    if ((arriveBy && !TIME_RE.test(arriveBy)) || (leaveFrom && !TIME_RE.test(leaveFrom))) throw new HttpError(400, 'Times must look like 09:30.');
    if (Array.isArray(b.weekdays) && b.weekdays.length) {
      weekdays = [...new Set(b.weekdays.map(Number).filter((d) => d >= 0 && d <= 6))].sort();
    }
  } else if (part !== 'full' && start !== end) {
    throw new HttpError(400, 'A half day must be a single date.');
  }
  const reason = String(b.reason || '').trim().slice(0, 500);
  return { type, start, end, part, arriveBy, leaveFrom, weekdays, reason };
}

function assertNoOverlap(userId, v, ignoreId = 0) {
  const clash = db
    .prepare(
      `SELECT 1 FROM time_off WHERE user_id = ? AND id != ? AND status IN ('pending', 'approved')
       AND start_date <= ? AND end_date >= ? AND (type = 'adjusted') = ?`,
    )
    .get(userId, ignoreId, v.end, v.start, v.type === 'adjusted' ? 1 : 0);
  if (clash) throw new HttpError(409, 'There is already time off for those dates. Cancel or change it first.');
}

function describe(t) {
  const range = t.start_date === t.end_date ? t.start_date : `${t.start_date} – ${t.end_date}`;
  if (t.type === 'adjusted') {
    const parts = [t.arrive_by && `arrive by ${t.arrive_by}`, t.leave_from && `leave from ${t.leave_from}`].filter(Boolean).join(', ');
    return `${range}: ${parts}`;
  }
  return `${range}${t.part === 'am' ? ' (morning)' : t.part === 'pm' ? ' (afternoon)' : ''}`;
}

function publicTimeOff(t, names, inst, s) {
  const ctx = loadPlanContext(inst.id, s, t.start_date, t.end_date, [t.user_id]);
  const days = t.type === 'adjusted' ? null : countWorkingDays(ctx, t.user_id, t.start_date, t.end_date, t.part);
  return {
    id: t.id,
    userId: t.user_id,
    name: names.get(t.user_id) || '',
    type: t.type,
    typeLabel: TIME_OFF_TYPES[t.type],
    startDate: t.start_date,
    endDate: t.end_date,
    part: t.part,
    arriveBy: t.arrive_by,
    leaveFrom: t.leave_from,
    weekdays: t.weekdays ? JSON.parse(t.weekdays) : null,
    reason: t.reason,
    status: t.status,
    workingDays: days,
    requestedBy: names.get(t.requested_by) || null,
    decidedBy: names.get(t.decided_by) || null,
    decidedAt: t.decided_at,
    decisionNote: t.decision_note,
    createdAt: t.created_at,
    summary: describe(t),
  };
}

const nameMap = (instId) =>
  new Map(db.prepare('SELECT id, name FROM users WHERE institution_id = ? OR institution_id IS NULL').all(instId).map((u) => [u.id, u.name]));

// ---------------------------------------------------------------- employees: my time off

export const mine = express.Router();
mine.use(requireAuth, requireInstitution, noSupport);

mine.get('/', (req, res) => {
  const s = getSettings(req.inst.id);
  const names = nameMap(req.inst.id);
  const rows = db.prepare('SELECT * FROM time_off WHERE user_id = ? ORDER BY start_date DESC, id DESC LIMIT 100').all(req.user.id);
  const mgr = managerOf(req.user);
  res.json({ requests: rows.map((t) => publicTimeOff(t, names, req.inst, s)), approver: mgr ? mgr.name : 'HR' });
});

mine.post('/', (req, res) => {
  const v = parseTimeOff(req.body);
  assertNoOverlap(req.user.id, v);
  const id = Number(
    db
      .prepare(
        `INSERT INTO time_off (institution_id, user_id, type, start_date, end_date, part, arrive_by, leave_from, weekdays, reason, status, requested_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(req.inst.id, req.user.id, v.type, v.start, v.end, v.part, v.arriveBy, v.leaveFrom, v.weekdays ? JSON.stringify(v.weekdays) : null, v.reason, req.user.id, nowIso())
      .lastInsertRowid,
  );
  const t = db.prepare('SELECT * FROM time_off WHERE id = ?').get(id);
  const s = getSettings(req.inst.id);
  const mgr = managerOf(req.user);
  const appUrl = (process.env.APP_URL || '').replace(/\/+$/, '');
  sendMail({
    to: mgr ? [mgr.email] : alertRecipients(s),
    brand: req.inst,
    subject: `Time off request: ${req.user.name} (${TIME_OFF_TYPES[t.type]})`,
    text:
      `${req.user.name} requested ${TIME_OFF_TYPES[t.type].toLowerCase()}: ${describe(t)}.\n` +
      (t.reason ? `Reason: ${t.reason}\n` : '') +
      `\nApprove or decline it in the app${appUrl ? `: ${appUrl}/${req.inst.code}` : ''} (Time off).\n`,
  });
  res.status(201).json({ request: publicTimeOff(t, nameMap(req.inst.id), req.inst, s), message: `Request sent to ${mgr ? mgr.name : 'HR'}.` });
});

mine.post('/:id/cancel', (req, res) => {
  const t = db.prepare('SELECT * FROM time_off WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
  if (!t) throw new HttpError(404, 'Request not found.');
  if (t.status !== 'pending') throw new HttpError(409, 'Only pending requests can be cancelled. Ask your manager to change approved time off.');
  db.prepare("UPDATE time_off SET status = 'cancelled', decided_at = ? WHERE id = ?").run(nowIso(), t.id);
  res.json({ message: 'Request cancelled.' });
});

// ---------------------------------------------------------------- managers and admins

export const team = express.Router();
team.use(requireAuth, requireStaff);

/** People in scope with their contract and manager — for "My team" and pickers. */
team.get('/people', (req, res) => {
  const s = getSettings(req.inst.id);
  const today = localParts(new Date(), s.timezone).date;
  const sc = scopeSql(req);
  const rows = db.prepare(`SELECT u.* FROM users u WHERE ${sc.sql} AND u.role != 'owner' ORDER BY u.name COLLATE NOCASE`).all(...sc.params);
  const terms = latestTermsMap(req.inst.id, today);
  const names = nameMap(req.inst.id);
  res.json(
    rows.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      active: !!u.active,
      managerId: u.manager_id,
      managerName: names.get(u.manager_id) || null,
      contract: contractSummary(terms.get(u.id), s),
      partTime: terms.get(u.id)?.employment_type === 'part_time',
    })),
  );
});

/** Attendance for a day (with each person's plan) or a range of records. */
team.get('/attendance', (req, res) => {
  const s = getSettings(req.inst.id);
  const nowParts = localParts(new Date(), s.timezone);
  const today = nowParts.date;
  const from = DATE_RE.test(req.query.from) ? req.query.from : today;
  const to = DATE_RE.test(req.query.to) ? req.query.to : from;
  const sc = scopeSql(req);
  const terms = latestTermsMap(req.inst.id, to);
  const corrected = new Set(
    db.prepare('SELECT DISTINCT attendance_id FROM attendance_corrections WHERE institution_id = ?').all(req.inst.id).map((r) => r.attendance_id),
  );

  const shape = (r, plan) => {
    const hasRecord = Boolean(r.id);
    const worked = r.check_in_at && r.check_out_at ? minutesBetween(r.check_in_at, r.check_out_at) : null;
    let status = 'present';
    if (!hasRecord) {
      if (!plan || !plan.expected) status = 'not_expected';
      else if (r.date < today || nowParts.minutes >= toMinutes(plan.start) + s.graceMinutes) status = 'absent';
      else status = 'not_yet';
    } else if (!r.check_out_at && (r.date < today || (plan?.expected && nowParts.minutes >= toMinutes(plan.end)))) {
      status = 'no_checkout';
    }
    return {
      user_id: r.user_id,
      name: r.name,
      email: r.email,
      date: r.date,
      contract: contractSummary(terms.get(r.user_id), s),
      id: r.id || null,
      check_in_at: r.check_in_at || null,
      check_out_at: r.check_out_at || null,
      check_in_distance: r.check_in_distance ?? null,
      late: r.late || 0,
      late_minutes: r.late_minutes || 0,
      early: r.early || 0,
      early_minutes: r.early_minutes || 0,
      workedMinutes: worked,
      edited: hasRecord && (r.source !== 'gps' || corrected.has(r.id)),
      status,
      plan: plan ? { expected: plan.expected, reason: plan.reason, label: plan.label, start: plan.start || null, end: plan.end || null } : null,
    };
  };

  if (from === to) {
    const ctx = loadPlanContext(req.inst.id, s, from, from);
    const rows = db
      .prepare(
        `SELECT u.id AS user_id, u.name, u.email, ? AS date,
                a.id, a.check_in_at, a.check_out_at, a.check_in_distance, a.late, a.late_minutes,
                a.early, a.early_minutes, a.source
         FROM users u LEFT JOIN attendance a ON a.user_id = u.id AND a.date = ?
         WHERE ${sc.sql} AND u.role != 'owner' AND (u.active = 1 OR a.id IS NOT NULL)
         ORDER BY u.name COLLATE NOCASE`,
      )
      .all(from, from, ...sc.params);
    return res.json({ from, to, rows: rows.map((r) => shape(r, ctx.dayPlan(r.user_id, from))) });
  }
  const rows = db
    .prepare(
      `SELECT a.*, u.name, u.email FROM attendance a JOIN users u ON u.id = a.user_id
       WHERE ${sc.sql} AND a.date BETWEEN ? AND ? ORDER BY a.date DESC, u.name COLLATE NOCASE LIMIT 5000`,
    )
    .all(...sc.params, from, to);
  res.json({ from, to, rows: rows.map((r) => shape(r, null)) });
});

function attendanceInScope(req) {
  const r = db.prepare('SELECT a.*, u.name, u.institution_id, u.manager_id FROM attendance a JOIN users u ON u.id = a.user_id WHERE a.id = ?').get(Number(req.params.id));
  if (!r || r.institution_id !== req.inst.id) throw new HttpError(404, 'Record not found.');
  if (req.user.role !== 'admin' && r.manager_id !== req.user.id) throw new HttpError(404, 'Record not found.');
  return r;
}

/** Fix a check-in/check-out time. A reason is required; every change is kept in the audit trail. */
team.patch('/attendance/:id', (req, res) => {
  const rec = attendanceInScope(req);
  const s = getSettings(req.inst.id);
  const reason = String(req.body.reason || '').trim();
  if (reason.length < 3) throw new HttpError(400, 'Give a reason for the change.');
  const inT = req.body.checkIn ? String(req.body.checkIn) : null;
  const outT = req.body.checkOut ? String(req.body.checkOut) : null;
  if (!inT && !outT) throw new HttpError(400, 'Set a check-in or check-out time.');
  if ((inT && !TIME_RE.test(inT)) || (outT && !TIME_RE.test(outT))) throw new HttpError(400, 'Times must look like 17:00.');

  const newIn = inT ? zonedTimeToUtc(rec.date, inT, s.timezone).toISOString() : rec.check_in_at;
  let newOut = outT ? zonedTimeToUtc(rec.date, outT, s.timezone) : rec.check_out_at ? new Date(rec.check_out_at) : null;
  if (newOut && newOut <= new Date(newIn)) newOut = new Date(newOut.getTime() + 24 * 3600 * 1000); // e.g. a night shift ending after midnight
  if (newOut && newOut > new Date()) throw new HttpError(400, 'The check-out time can’t be in the future.');
  if (newOut && newOut - new Date(newIn) > 16 * 3600 * 1000) throw new HttpError(400, 'Check-out must be after check-in, and a shift can’t be longer than 16 hours.');

  const plan = loadPlanContext(req.inst.id, s, rec.date, rec.date, [rec.user_id]).dayPlan(rec.user_id, rec.date);
  const inLocal = localParts(new Date(newIn), s.timezone).minutes;
  const late = plan.expected && inLocal > toMinutes(plan.start) + s.graceMinutes;
  const outLocal = newOut ? localParts(newOut, s.timezone) : null;
  const early = Boolean(plan.expected && outLocal && outLocal.date === rec.date && outLocal.minutes < toMinutes(plan.end));

  tx(() => {
    const audit = db.prepare(
      'INSERT INTO attendance_corrections (institution_id, attendance_id, changed_by, field, old_value, new_value, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    if (inT && newIn !== rec.check_in_at) audit.run(req.inst.id, rec.id, req.user.id, 'check_in', rec.check_in_at, newIn, reason, nowIso());
    const outIso = newOut ? newOut.toISOString() : null;
    if (outT && outIso !== rec.check_out_at) audit.run(req.inst.id, rec.id, req.user.id, 'check_out', rec.check_out_at, outIso, reason, nowIso());
    db.prepare(
      `UPDATE attendance SET check_in_at = ?, check_out_at = ?, late = ?, late_minutes = ?, early = ?, early_minutes = ?, source = 'edited' WHERE id = ?`,
    ).run(newIn, outIso, late ? 1 : 0, late ? inLocal - toMinutes(plan.start) : 0, early ? 1 : 0, early ? toMinutes(plan.end) - outLocal.minutes : 0, rec.id);
  });
  logEvent(req.inst.id, req.user.id, 'attendance_edit', `${req.user.name} corrected ${rec.name}'s record for ${rec.date}: ${reason}`);
  res.json({ record: db.prepare('SELECT * FROM attendance WHERE id = ?').get(rec.id), message: 'Correction saved.' });
});

team.get('/attendance/:id/history', (req, res) => {
  const rec = attendanceInScope(req);
  const s = getSettings(req.inst.id);
  const names = nameMap(req.inst.id);
  const rows = db.prepare('SELECT * FROM attendance_corrections WHERE attendance_id = ? ORDER BY id DESC').all(rec.id);
  res.json({
    record: { id: rec.id, date: rec.date, name: rec.name, source: rec.source },
    changes: rows.map((c) => ({
      field: c.field,
      from: c.old_value ? formatTime(c.old_value, s.timezone) : null,
      to: c.new_value ? formatTime(c.new_value, s.timezone) : null,
      by: names.get(c.changed_by) || 'Unknown',
      at: c.created_at,
      reason: c.reason,
    })),
  });
});

// Time off — list, record, decide, cancel
team.get('/time-off', (req, res) => {
  const s = getSettings(req.inst.id);
  const sc = scopeSql(req);
  const status = ['pending', 'approved', 'declined', 'cancelled'].includes(req.query.status) ? req.query.status : null;
  const rows = db
    .prepare(
      `SELECT t.* FROM time_off t JOIN users u ON u.id = t.user_id
       WHERE ${sc.sql} AND t.user_id != ? ${status ? 'AND t.status = ?' : ''}
       ORDER BY CASE t.status WHEN 'pending' THEN 0 ELSE 1 END, t.start_date DESC, t.id DESC LIMIT 300`,
    )
    .all(...sc.params, req.user.id, ...(status ? [status] : []));
  const names = nameMap(req.inst.id);
  res.json(rows.map((t) => publicTimeOff(t, names, req.inst, s)));
});

team.post('/time-off', (req, res) => {
  const target = userInScope(req, req.body.userId);
  if (!target || target.id === req.user.id) throw new HttpError(404, 'Choose someone on your team.');
  const v = parseTimeOff(req.body);
  assertNoOverlap(target.id, v);
  const id = Number(
    db
      .prepare(
        `INSERT INTO time_off (institution_id, user_id, type, start_date, end_date, part, arrive_by, leave_from, weekdays, reason, status, requested_by, decided_by, decided_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?)`,
      )
      .run(req.inst.id, target.id, v.type, v.start, v.end, v.part, v.arriveBy, v.leaveFrom, v.weekdays ? JSON.stringify(v.weekdays) : null, v.reason, req.user.id, req.user.id, nowIso(), nowIso())
      .lastInsertRowid,
  );
  const t = db.prepare('SELECT * FROM time_off WHERE id = ?').get(id);
  const s = getSettings(req.inst.id);
  logEvent(req.inst.id, req.user.id, 'time_off', `${req.user.name} recorded ${TIME_OFF_TYPES[t.type].toLowerCase()} for ${target.name}: ${describe(t)}.`);
  sendMail({
    to: [target.email],
    brand: req.inst,
    subject: `${TIME_OFF_TYPES[t.type]} recorded: ${describe(t)}`,
    text: `Hi ${target.name},\n\n${req.user.name} recorded ${TIME_OFF_TYPES[t.type].toLowerCase()} for you: ${describe(t)}.\n`,
  });
  res.status(201).json({ request: publicTimeOff(t, nameMap(req.inst.id), req.inst, s), message: `Saved for ${target.name}.` });
});

function timeOffInScope(req) {
  const t = db.prepare('SELECT * FROM time_off WHERE id = ? AND institution_id = ?').get(Number(req.params.id), req.inst.id);
  if (!t || !userInScope(req, t.user_id) || t.user_id === req.user.id) throw new HttpError(404, 'Request not found.');
  return t;
}

team.post('/time-off/:id/decide', (req, res) => {
  const t = timeOffInScope(req);
  if (t.status !== 'pending') throw new HttpError(409, `This request was already ${t.status}.`);
  const approve = req.body.decision === 'approve';
  if (!approve && req.body.decision !== 'decline') throw new HttpError(400, 'Decision must be approve or decline.');
  const note = String(req.body.note || '').trim().slice(0, 500);
  if (!approve && note.length < 3) throw new HttpError(400, 'Give a reason for declining; it’s sent to the employee.');
  db.prepare('UPDATE time_off SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?').run(
    approve ? 'approved' : 'declined',
    req.user.id,
    nowIso(),
    note || null,
    t.id,
  );
  const person = db.prepare('SELECT * FROM users WHERE id = ?').get(t.user_id);
  sendMail({
    to: [person.email],
    brand: req.inst,
    subject: `Time off ${approve ? 'approved' : 'declined'}: ${describe(t)}`,
    text:
      `Hi ${person.name},\n\n${req.user.name} ${approve ? 'approved' : 'declined'} your ${TIME_OFF_TYPES[t.type].toLowerCase()} request (${describe(t)}).\n` +
      (note ? `\n"${note}"\n` : ''),
  });
  logEvent(req.inst.id, req.user.id, 'time_off', `${req.user.name} ${approve ? 'approved' : 'declined'} ${person.name}'s ${TIME_OFF_TYPES[t.type].toLowerCase()} (${describe(t)}).`);
  res.json({ message: `${approve ? 'Approved' : 'Declined'}. ${person.name} has been notified.` });
});

team.post('/time-off/:id/cancel', (req, res) => {
  const t = timeOffInScope(req);
  if (!['pending', 'approved'].includes(t.status)) throw new HttpError(409, `This request is already ${t.status}.`);
  db.prepare("UPDATE time_off SET status = 'cancelled', decided_by = ?, decided_at = ? WHERE id = ?").run(req.user.id, nowIso(), t.id);
  logEvent(req.inst.id, req.user.id, 'time_off', `${req.user.name} cancelled time off ${describe(t)}.`);
  res.json({ message: 'Time off cancelled.' });
});

// Reports (scoped)
async function reportJob(req, q, task, format) {
  try {
    return await runReportJob({
      task,
      format,
      instId: req.inst.id,
      generatedBy: req.user.name,
      query: { type: q.type, from: q.from, to: q.to, userId: q.userId || null, userIds: teamScope(req) },
    });
  } catch (err) {
    throw new HttpError(err.status || 500, err.status ? err.message : 'The report could not be built.');
  }
}

team.get('/reports', async (req, res) => {
  const format = req.query.format;
  if (['csv', 'xlsx', 'pdf'].includes(format)) {
    const file = await reportJob(req, req.query, 'export', format);
    res.setHeader('Content-Type', file.type);
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    return res.send(Buffer.from(file.buffer));
  }
  res.json(await reportJob(req, req.query, 'preview'));
});

team.post('/reports/email', async (req, res) => {
  const format = ['csv', 'xlsx', 'pdf'].includes(req.body.format) ? req.body.format : 'xlsx';
  const file = await reportJob(req, req.body, 'export', format);
  const result = await sendMail({
    to: [req.user.email],
    brand: req.inst,
    subject: `${file.title}: ${file.period}`,
    text: `Attached is the ${file.title.toLowerCase()} report for ${req.inst.name}, ${file.period}.\n`,
    attachments: [{ filename: file.fileName, content: Buffer.from(file.buffer) }],
  });
  if (!result.sent && smtpConfigured) throw new HttpError(502, `Sending failed: ${result.error}`);
  res.json({ message: smtpConfigured ? `Report sent to ${req.user.email}.` : 'SMTP is not configured; the email was printed in the server console.' });
});
