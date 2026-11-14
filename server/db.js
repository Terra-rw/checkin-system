import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread } from 'node:worker_threads';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const dbPath = path.resolve(process.env.DB_PATH || path.join(__dirname, 'data.db'));

// The main thread owns the database: it runs migrations and does all writes.
// Worker threads (the report builder) open a read-only connection and never migrate.
const readOnly = !isMainThread;

// ---------------------------------------------------------------- data-loss guard
// On a hosted server the app folder is replaced on every deploy, so a database kept inside it
// is silently wiped. In production we refuse to start unless DB_PATH points outside the app.
const APP_ROOT = path.resolve(__dirname, '..');
const isProduction = process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER);
const insideApp = !path.relative(APP_ROOT, dbPath).startsWith('..') && !path.isAbsolute(path.relative(APP_ROOT, dbPath));
if (!readOnly && isProduction && (!process.env.DB_PATH || insideApp)) {
  console.error(
    '\n[db] REFUSING TO START: the database would be stored inside the app folder\n' +
      `     (${dbPath}), which is replaced on every deploy, so all data would be lost.\n` +
      '     Set DB_PATH to a file on a persistent disk, e.g. DB_PATH=/var/data/checkin.db (Render)\n' +
      '     or DB_PATH=/data/checkin.db (AWS EBS volume).\n',
  );
  process.exit(1);
}
const dbExisted = fs.existsSync(dbPath);

export const db = new DatabaseSync(dbPath, { readOnly });
// If the database is briefly locked (e.g. a checkpoint while a report reads), wait up to
// 5 s instead of failing the request with SQLITE_BUSY.
db.exec('PRAGMA busy_timeout = 5000;');
if (!readOnly) db.exec('PRAGMA journal_mode = WAL;');

/** Runs `fn` inside a transaction. */
export function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---------------------------------------------------------------- migrations
// PRAGMA user_version tracks which migrations have run.
//   1: original single-institution schema
//   2: institutions (multi-tenancy), platform owner, password reset, device codes

function migrate() {
  // Table rebuilds below must not trigger ON DELETE CASCADE.
  db.exec('PRAGMA foreign_keys = OFF;');
  const version = db.prepare('PRAGMA user_version').get().user_version;

  if (version < 1) {
    db.exec(`
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
        date               TEXT NOT NULL,
        check_in_at        TEXT NOT NULL,
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
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notification_log (date TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (date, kind));
      PRAGMA user_version = 1;
    `);
  }

  if (version < 2) {
    tx(() => {
      db.exec(`
        CREATE TABLE institutions (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          name       TEXT NOT NULL,
          code       TEXT NOT NULL UNIQUE COLLATE NOCASE,
          status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);

      // An existing single-institution install becomes the first institution.
      let instId = null;
      const { count } = db.prepare('SELECT COUNT(*) AS count FROM users').get();
      if (count > 0) {
        const code = normalizeCode(process.env.DEFAULT_INSTITUTION_CODE || 'main');
        const name = process.env.DEFAULT_INSTITUTION_NAME || 'My Institution';
        instId = Number(db.prepare('INSERT INTO institutions (name, code) VALUES (?, ?)').run(name, code).lastInsertRowid);
        console.log(`[migrate] Existing data moved into institution "${name}" (code: ${code}).`);
      }

      db.exec(`
        CREATE TABLE users_new (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          institution_id INTEGER REFERENCES institutions(id) ON DELETE CASCADE, -- NULL for platform owners
          name           TEXT NOT NULL,
          email          TEXT NOT NULL,
          password_hash  TEXT,                        -- NULL until an invited user sets one
          role           TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('employee', 'admin', 'owner')),
          active         INTEGER NOT NULL DEFAULT 1,
          token_version  INTEGER NOT NULL DEFAULT 0,  -- bumping it logs the user out everywhere
          failed_logins  INTEGER NOT NULL DEFAULT 0,
          locked_until   TEXT,
          created_at     TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (institution_id, email)
        );
      `);
      db.prepare(
        `INSERT INTO users_new (id, institution_id, name, email, password_hash, role, active, created_at)
         SELECT id, ?, name, email, password_hash, role, active, created_at FROM users`,
      ).run(instId);
      db.exec('DROP TABLE users; ALTER TABLE users_new RENAME TO users;');

      db.exec(`
        CREATE TABLE settings_new (
          institution_id INTEGER NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
          key            TEXT NOT NULL,
          value          TEXT NOT NULL,
          PRIMARY KEY (institution_id, key)
        );
        CREATE TABLE notification_log_new (
          institution_id INTEGER NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
          date           TEXT NOT NULL,
          kind           TEXT NOT NULL,
          PRIMARY KEY (institution_id, date, kind)
        );
      `);
      if (instId) {
        db.prepare('INSERT INTO settings_new SELECT ?, key, value FROM settings').run(instId);
        // v1 fell back to the server's timezone when none was saved; keep that behaviour explicit.
        db.prepare("INSERT OR IGNORE INTO settings_new (institution_id, key, value) VALUES (?, 'timezone', ?)").run(
          instId,
          JSON.stringify(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),
        );
        db.prepare('INSERT INTO notification_log_new SELECT ?, date, kind FROM notification_log').run(instId);
      }
      db.exec(`
        DROP TABLE settings; ALTER TABLE settings_new RENAME TO settings;
        DROP TABLE notification_log; ALTER TABLE notification_log_new RENAME TO notification_log;

        -- Password reset links, invites and trusted devices. Only SHA-256 hashes are stored.
        CREATE TABLE tokens (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          kind         TEXT NOT NULL CHECK (kind IN ('reset', 'invite', 'device')),
          token_hash   TEXT NOT NULL UNIQUE,
          label        TEXT,
          created_at   TEXT NOT NULL,
          expires_at   TEXT NOT NULL,
          used_at      TEXT,
          last_used_at TEXT
        );

        -- A login waiting for the emailed 6-digit code.
        CREATE TABLE login_challenges (
          id           TEXT PRIMARY KEY,
          user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          code_hash    TEXT NOT NULL,
          label        TEXT,
          attempts     INTEGER NOT NULL DEFAULT 0,
          last_sent_at TEXT NOT NULL,
          expires_at   TEXT NOT NULL
        );

        CREATE TABLE security_events (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          institution_id INTEGER REFERENCES institutions(id) ON DELETE CASCADE,
          user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
          kind           TEXT NOT NULL,
          detail         TEXT NOT NULL,
          created_at     TEXT NOT NULL
        );

        CREATE INDEX attendance_date ON attendance (date);
        CREATE INDEX users_institution ON users (institution_id);
        CREATE INDEX events_institution ON security_events (institution_id, created_at);
        PRAGMA user_version = 2;
      `);
    });
  }

  if (db.prepare('PRAGMA user_version').get().user_version < 3) {
    // Branding: uploaded files live in UPLOAD_DIR; only their generated names are stored here.
    db.exec(`
      ALTER TABLE institutions ADD COLUMN logo_file TEXT;
      ALTER TABLE institutions ADD COLUMN photo_file TEXT;
      ALTER TABLE institutions ADD COLUMN photo_focus_x REAL NOT NULL DEFAULT 50;
      ALTER TABLE institutions ADD COLUMN photo_focus_y REAL NOT NULL DEFAULT 50;
      ALTER TABLE institutions ADD COLUMN photo_dim INTEGER NOT NULL DEFAULT 1;
      PRAGMA user_version = 3;
    `);
  }

  db.exec('PRAGMA foreign_keys = ON;');
}

export function normalizeCode(code) {
  return String(code || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

if (!readOnly) {
  migrate();
  // Say where the data lives, so a wrong path is obvious in the logs after every deploy.
  const n = (sql) => db.prepare(sql).get().c;
  console.log(
    `[db] Database: ${dbPath} — ${n('SELECT COUNT(*) c FROM institutions')} institutions, ` +
      `${n("SELECT COUNT(*) c FROM users WHERE role != 'owner'")} people, ${n('SELECT COUNT(*) c FROM attendance')} attendance records`,
  );
  if (!dbExisted) {
    console.warn(
      '\n[db] WARNING: no database existed at this path, so a NEW, EMPTY one was created.\n' +
        '     If this server already had data, the persistent disk is not mounted where DB_PATH points.\n' +
        '     Stop and fix the disk / DB_PATH before anyone uses the app.\n',
    );
  }
}

// ---------------------------------------------------------------- settings (per institution)

export const DEFAULT_SETTINGS = {
  officeName: 'Main Office',
  officeLat: null,
  officeLng: null,
  radiusMeters: 150,
  maxAccuracyMeters: 100,
  workStart: '08:00',
  workEnd: '17:00',
  graceMinutes: 10,
  workDays: [1, 2, 3, 4, 5], // 0 = Sunday ... 6 = Saturday
  timezone: 'UTC',
  alertEmails: '',
  emailEmployee: true,
  notifyEarlyCheckout: true,
  notifyNoShow: true,
  weeklyReport: false, // email last week's summary to alert emails every Monday
  // Security
  require2fa: true, // email a code when someone logs in on a new device
  trustDays: 90,
  codeMinutes: 10,
  resetMinutes: 30,
};

export function getSettings(institutionId) {
  const rows = db.prepare('SELECT key, value FROM settings WHERE institution_id = ?').all(institutionId);
  const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
  return { ...DEFAULT_SETTINGS, ...stored };
}

export function saveSettings(institutionId, values) {
  const upsert = db.prepare(
    `INSERT INTO settings (institution_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(institution_id, key) DO UPDATE SET value = excluded.value`,
  );
  for (const [key, value] of Object.entries(values)) {
    if (key in DEFAULT_SETTINGS) upsert.run(institutionId, key, JSON.stringify(value));
  }
  return getSettings(institutionId);
}

// ---------------------------------------------------------------- misc helpers

export function logEvent(institutionId, userId, kind, detail) {
  db.prepare(
    'INSERT INTO security_events (institution_id, user_id, kind, detail, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(institutionId ?? null, userId ?? null, kind, detail, new Date().toISOString());
}

/** Creates the platform owner account from env vars if none exists yet. */
export function seedOwner() {
  const existing = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'owner'").get();
  if (existing.count > 0) return;

  const email = (process.env.PLATFORM_OWNER_EMAIL || '').trim().toLowerCase();
  if (!email) {
    console.warn('[setup] No platform owner yet. Set PLATFORM_OWNER_EMAIL (and PLATFORM_OWNER_PASSWORD), then restart.');
    return;
  }
  let password = process.env.PLATFORM_OWNER_PASSWORD;
  if (!password) {
    password = crypto.randomBytes(9).toString('base64url');
    console.log('\n================================================================');
    console.log(' Created platform owner account:');
    console.log(`   email:    ${email}`);
    console.log(`   password: ${password}`);
    console.log(' Log in at /platform and change it with "Forgot password".');
    console.log('================================================================\n');
  }
  db.prepare("INSERT INTO users (institution_id, name, email, password_hash, role) VALUES (NULL, ?, ?, ?, 'owner')").run(
    process.env.PLATFORM_OWNER_NAME || 'Platform owner',
    email,
    bcrypt.hashSync(password, 10),
  );
}
