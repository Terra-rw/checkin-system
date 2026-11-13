import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || path.join(__dirname, 'data.db');

export const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('employee', 'admin')),
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS attendance (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date               TEXT NOT NULL,           -- local date (settings timezone), YYYY-MM-DD
    check_in_at        TEXT NOT NULL,           -- ISO timestamp (server clock)
    check_in_lat       REAL,
    check_in_lng       REAL,
    check_in_distance  REAL,
    check_in_accuracy  REAL,
    late               INTEGER NOT NULL DEFAULT 0,
    late_minutes       INTEGER NOT NULL DEFAULT 0,
    check_out_at       TEXT,
    check_out_lat      REAL,
    check_out_lng      REAL,
    check_out_distance REAL,
    check_out_accuracy REAL,
    early              INTEGER NOT NULL DEFAULT 0,
    early_minutes      INTEGER NOT NULL DEFAULT 0,
    UNIQUE (user_id, date)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Remembers which once-a-day notifications (e.g. no-show summary) were sent.
  CREATE TABLE IF NOT EXISTS notification_log (
    date TEXT NOT NULL,
    kind TEXT NOT NULL,
    PRIMARY KEY (date, kind)
  );
`);

export const DEFAULT_SETTINGS = {
  officeName: 'Main Office',
  officeLat: null,
  officeLng: null,
  radiusMeters: 150, // how close to the office someone must be
  maxAccuracyMeters: 100, // reject GPS fixes worse than this
  workStart: '08:00',
  workEnd: '17:00',
  graceMinutes: 10, // check-ins after workStart + grace are "late"
  workDays: [1, 2, 3, 4, 5], // 0 = Sunday ... 6 = Saturday
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  alertEmails: '', // comma-separated manager/HR addresses
  emailEmployee: true, // also email the employee who was late / left early
  notifyEarlyCheckout: true,
  notifyNoShow: true, // email a summary of people who haven't checked in by the deadline
};

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
  return { ...DEFAULT_SETTINGS, ...stored };
}

export function saveSettings(values) {
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  for (const [key, value] of Object.entries(values)) {
    if (key in DEFAULT_SETTINGS) upsert.run(key, JSON.stringify(value));
  }
  return getSettings();
}

/** Creates the first admin account when the database is empty. */
export function seedAdmin() {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM users').get();
  if (count > 0) return;

  const email = (process.env.ADMIN_EMAIL || 'admin@example.com').toLowerCase();
  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    password = crypto.randomBytes(6).toString('base64url');
    console.log('\n================================================================');
    console.log(' No ADMIN_PASSWORD set. Created first admin account:');
    console.log(`   email:    ${email}`);
    console.log(`   password: ${password}`);
    console.log(' Log in and change it (Admin > Employees > Reset password).');
    console.log('================================================================\n');
  }
  db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')").run(
    process.env.ADMIN_NAME || 'Administrator',
    email,
    bcrypt.hashSync(password, 10),
  );
}
