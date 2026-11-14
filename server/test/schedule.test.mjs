// Unit tests for the "is this person expected?" rules (server/schedule.js).
// Runs in-process on a throwaway database.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reporter } from './helpers.mjs';

export async function run() {
  const t = reporter('Schedule rules');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-sched-'));
  process.env.DB_PATH = path.join(dir, 'sched.db');
  process.env.UPLOAD_DIR = path.join(dir, 'uploads');
  const { db, saveSettings, getSettings } = await import('../db.js');
  const { loadPlanContext, countWorkingDays } = await import('../schedule.js');

  try {
    const inst = Number(db.prepare("INSERT INTO institutions (name, code) VALUES ('T', 't')").run().lastInsertRowid);
    saveSettings(inst, { timezone: 'Africa/Kigali', workStart: '08:00', workEnd: '17:00', workDays: [1, 2, 3, 4, 5] });
    const s = getSettings(inst);
    const user = (name) => Number(db.prepare("INSERT INTO users (institution_id, name, email, role) VALUES (?, ?, ?, 'employee')").run(inst, name, `${name}@t`).lastInsertRowid);
    const now = new Date().toISOString();
    const terms = (uid, from, type, schedule, minutes = null, period = null) =>
      db.prepare('INSERT INTO work_terms (institution_id, user_id, effective_from, employment_type, contract_minutes, contract_period, schedule, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(inst, uid, from, type, minutes, period, schedule ? JSON.stringify(schedule) : null, now);
    const off = (uid, type, a, b, extra = {}) =>
      db.prepare('INSERT INTO time_off (institution_id, user_id, type, start_date, end_date, part, arrive_by, leave_from, weekdays, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(inst, uid, type, a, b, extra.part || 'full', extra.arrive || null, extra.leave || null, extra.weekdays ? JSON.stringify(extra.weekdays) : null, extra.status || 'approved', now);

    const full = user('full');
    const custom = user('custom');
    terms(custom, '2026-01-01', 'full_time', { 1: null, 2: null, 3: null, 4: null });
    const fixed = user('fixed');
    terms(fixed, '2026-01-01', 'part_time', { 2: ['09:00', '13:00'], 4: ['09:00', '13:00'] }, 12 * 60, 'week');
    const flex = user('flex');
    terms(flex, '2026-01-01', 'part_time', null, 20 * 60, 'week');
    const later = user('later');
    terms(later, '2026-11-20', 'part_time', { 1: ['10:00', '14:00'] }, 4 * 60, 'week');

    db.prepare("INSERT INTO holidays (institution_id, start_date, end_date, name, kind, yearly, created_at) VALUES (?, '2026-12-25', '2026-12-25', 'Christmas Day', 'public', 1, ?)").run(inst, now);
    db.prepare("INSERT INTO holidays (institution_id, start_date, end_date, name, kind, yearly, created_at) VALUES (?, '2026-11-26', '2026-11-26', 'Retreat', 'closure', 0, ?)").run(inst, now);

    off(full, 'sick', '2026-11-23', '2026-11-23');
    off(full, 'personal', '2026-11-24', '2026-11-24', { status: 'pending' });
    off(full, 'mission', '2026-11-30', '2026-12-02');
    off(full, 'personal', '2026-12-03', '2026-12-03', { part: 'am' });
    off(fixed, 'personal', '2026-12-01', '2026-12-01', { part: 'am' });
    off(fixed, 'adjusted', '2026-11-17', '2026-12-17', { arrive: '10:00', weekdays: [2] });
    off(full, 'declined-check', '2026-11-27', '2026-11-27', { status: 'declined' }).changes ?? 0;
  } catch (e) {
    // the "declined-check" type is invalid on purpose: the CHECK constraint must reject unknown types
    t.check('unknown time-off types are rejected by the database', /CHECK constraint failed/.test(e.message), e.message);
  }

  try {
    const { db: db2, getSettings } = await import('../db.js');
    const { loadPlanContext, countWorkingDays } = await import('../schedule.js');
    const inst = 1;
    const s = getSettings(inst);
    const id = (n) => db2.prepare('SELECT id FROM users WHERE name = ?').get(n).id;
    const ctx = loadPlanContext(inst, s, '2026-11-01', '2027-12-31');
    const plan = (n, d) => ctx.dayPlan(id(n), d);

    let p = plan('full', '2026-11-16');
    t.check('full-time Monday: expected 08:00–17:00', p.expected && p.start === '08:00' && p.end === '17:00' && p.baseMinutes === 540, JSON.stringify(p));
    p = plan('full', '2026-11-21');
    t.check('full-time Saturday: not a work day', !p.expected && p.reason === 'non_working_day', p.reason);
    p = plan('custom', '2026-11-20');
    t.check('custom Mon–Thu: Friday is a day off', !p.expected && p.reason === 'day_off' && p.label === 'Day off', p.reason);
    p = plan('custom', '2026-11-19');
    t.check('custom Mon–Thu: Thursday uses institution times', p.expected && p.start === '08:00', JSON.stringify(p));
    p = plan('fixed', '2026-11-18');
    t.check('part-time Tue/Thu: Wednesday not scheduled', !p.expected && p.reason === 'not_scheduled', p.reason);
    p = plan('fixed', '2026-11-19');
    t.check('part-time Thursday: 09:00–13:00', p.expected && p.start === '09:00' && p.end === '13:00' && p.baseMinutes === 240, JSON.stringify(p));
    p = plan('flex', '2026-11-18');
    t.check('flexible: never expected, flagged flexible', !p.expected && p.flexible && p.reason === 'flexible', p.reason);
    p = plan('full', '2026-11-26');
    t.check('closure: nobody expected', !p.expected && p.reason === 'holiday' && p.offFraction === 1, JSON.stringify(p));
    p = plan('full', '2027-12-25');
    t.check('yearly holiday repeats next year', !p.expected && p.reason === 'holiday', p.reason);
    p = plan('full', '2026-11-23');
    t.check('approved sick day: not expected, counts as leave', !p.expected && p.reason === 'time_off' && p.label === 'Sick' && p.offFraction === 1, JSON.stringify(p));
    p = plan('full', '2026-11-24');
    t.check('pending request: not expected (no absence alert), no leave counted', !p.expected && p.reason === 'pending' && p.offFraction === 0, JSON.stringify(p));
    p = plan('full', '2026-12-01');
    t.check('mission: credited as worked', !p.expected && p.reason === 'mission' && p.creditFraction === 1, JSON.stringify(p));
    p = plan('full', '2026-12-03');
    t.check('half day morning off: expected from 13:00', p.expected && p.start === '13:00' && p.end === '17:00' && p.offFraction === 0.5, JSON.stringify(p));
    p = plan('fixed', '2026-12-01');
    t.check('half day on a 09–13 shift splits at mid-shift (11:00)', p.expected && p.start === '11:00' && p.end === '13:00', JSON.stringify(p));
    p = plan('fixed', '2026-11-24');
    t.check('adjusted hours Tuesdays: may arrive by 10:00', p.expected && p.start === '10:00' && !!p.adjusted, JSON.stringify(p));
    p = plan('fixed', '2026-11-26');
    t.check('closure beats schedule (Thursday retreat)', !p.expected && p.reason === 'holiday', p.reason);
    p = plan('later', '2026-11-16');
    t.check('before a contract starts: institution default', p.expected && p.start === '08:00' && !p.partTime, JSON.stringify(p));
    p = plan('later', '2026-11-23');
    t.check('after the contract starts: its own schedule', p.expected && p.start === '10:00' && p.partTime, JSON.stringify(p));
    t.check('working days: custom Mon–Thu, 23–27 Nov with a Thursday closure = 3', countWorkingDays(ctx, id('custom'), '2026-11-23', '2026-11-27', 'full') === 3, String(countWorkingDays(ctx, id('custom'), '2026-11-23', '2026-11-27', 'full')));
    t.check('working days: half day counts 0.5', countWorkingDays(ctx, id('full'), '2026-11-23', '2026-11-23', 'am') === 0.5);
  } catch (e) {
    t.fail(e);
  }
  const { db: db3 } = await import('../db.js');
  db3.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  return t.done();
}
