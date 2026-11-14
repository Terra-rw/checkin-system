// Upgrade test: a database in the original v1 (single-institution) format must come through
// every migration with its people, attendance and settings intact.
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { startServer, loginWithCode, reporter, kigaliDate } from './helpers.mjs';

function createV1Database(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('employee', 'admin')),
      active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date TEXT NOT NULL, check_in_at TEXT NOT NULL, check_in_lat REAL, check_in_lng REAL, check_in_distance REAL,
      check_in_accuracy REAL, late INTEGER NOT NULL DEFAULT 0, late_minutes INTEGER NOT NULL DEFAULT 0,
      check_out_at TEXT, check_out_lat REAL, check_out_lng REAL, check_out_distance REAL, check_out_accuracy REAL,
      early INTEGER NOT NULL DEFAULT 0, early_minutes INTEGER NOT NULL DEFAULT 0, UNIQUE (user_id, date));
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE notification_log (date TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (date, kind));
  `);
  const hash = bcrypt.hashSync('old-admin-pass', 8);
  db.prepare("INSERT INTO users (name, email, password_hash, role, created_at) VALUES ('Old Admin', 'admin@old.test', ?, 'admin', '2026-01-01 00:00:00')").run(hash);
  db.prepare("INSERT INTO users (name, email, password_hash, created_at) VALUES ('Old Worker', 'worker@old.test', ?, '2026-01-01 00:00:00')").run(hash);
  const day = kigaliDate(-1);
  db.prepare('INSERT INTO attendance (user_id, date, check_in_at, late, late_minutes) VALUES (2, ?, ?, 1, 85)').run(day, `${day}T07:25:00.000Z`);
  for (const [k, v] of Object.entries({ officeName: 'Old HQ', radiusMeters: 120, alertEmails: 'boss@old.test', workStart: '08:00' })) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(k, JSON.stringify(v));
  }
  db.close();
  return day;
}

export async function run() {
  const t = reporter('Upgrade from v1 database');
  let day;
  const srv = await startServer({
    env: { DEFAULT_INSTITUTION_CODE: 'OldCo', DEFAULT_INSTITUTION_NAME: 'Old Company' },
    prepare: (_dir, dbPath) => {
      day = createV1Database(dbPath);
    },
  });
  const { call } = srv;
  try {
    t.check('migration message logged', /moved into institution "Old Company" \(code: oldco\)/.test(srv.log), srv.log.slice(0, 400));
    const inst = await call('GET', '/auth/institution/oldco');
    t.check('existing data became institution "oldco"', inst.status === 200 && inst.data.name === 'Old Company', JSON.stringify(inst.data));
    const admin = await loginWithCode(srv, 'oldco', 'admin@old.test', 'old-admin-pass');
    t.check('old admin can log in (with email code)', !!admin.token, JSON.stringify(admin));
    const users = (await call('GET', '/admin/users', null, admin.token)).data;
    t.check('both old users kept, admin still admin', users.length === 2 && users.find((u) => u.email === 'admin@old.test')?.role === 'admin', JSON.stringify(users));
    const s = (await call('GET', '/admin/settings', null, admin.token)).data.settings;
    t.check('old settings kept', s.officeName === 'Old HQ' && s.radiusMeters === 120 && s.alertEmails === 'boss@old.test', JSON.stringify(s));
    t.check('timezone recorded explicitly', typeof s.timezone === 'string' && s.timezone.length > 0, s.timezone);
    const rep = await call('GET', `/admin/reports?type=daily&from=${day}&to=${day}`, null, admin.token);
    const row = rep.data.rows?.find((x) => x.name === 'Old Worker');
    t.check('old attendance row survives with lateness in hr/min', row && row.lateMin === '1 hr 25 min', JSON.stringify(rep.data.rows));
    const branding = await call('GET', '/admin/branding', null, admin.token);
    t.check('branding columns added (no logo yet)', branding.status === 200 && branding.data.logoUrl === null, JSON.stringify(branding.data));
    const owner = await call('POST', '/auth/login', { email: 'owner@test.local', password: 'ownerpass1' });
    t.check('platform owner created on upgrade', !!owner.data.challenge, JSON.stringify(owner.data));
  } catch (e) {
    t.fail(e);
  } finally {
    await srv.stop();
  }
  return t.done(srv);
}
