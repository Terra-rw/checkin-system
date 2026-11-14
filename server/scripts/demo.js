// Demo mode: starts the app on a throwaway database filled with sample data.
//   npm run demo   (from the project root; builds the client first)
//
// - Uses server/demo.db, recreated on every run. Your real data.db and .env are never touched.
// - Emails (login codes, invites, alerts) are printed in this terminal instead of being sent.
// - All logins below are demo-only.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';

const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbFile = path.join(serverDir, 'demo.db');
for (const s of ['', '-wal', '-shm']) fs.rmSync(dbFile + s, { force: true });

const PORT = process.env.PORT || '4500';
Object.assign(process.env, {
  PORT,
  DB_PATH: dbFile,
  JWT_SECRET: 'demo-only-not-secret',
  APP_URL: `http://localhost:${PORT}`,
  SMTP_HOST: '',
  PLATFORM_OWNER_NAME: 'Platform owner',
  PLATFORM_OWNER_EMAIL: 'owner@demo.local',
  PLATFORM_OWNER_PASSWORD: 'demo-owner-1',
});

const LOGINS = [
  ['Platform owner', `/platform`, 'owner@demo.local', 'demo-owner-1'],
  ['NGA admin', `/nga`, 'hr@nga.demo', 'demo-admin-1'],
  ['NGA employee', `/nga`, 'eric@nga.demo', 'demo-staff-1'],
  ['Demo Clinic admin', `/demo-clinic`, 'admin@clinic.demo', 'demo-admin-1'],
];

const { db, saveSettings } = await import('../db.js');
const { localParts, dateRange, weekdayOf, addDays } = await import('../time.js');

const hash = (p) => bcrypt.hashSync(p, 8);
const TZ = 'Africa/Kigali';
const OFFSET_HOURS = 2; // Kigali is UTC+2 all year
const createdAt = new Date(Date.now() - 45 * 864e5).toISOString().replace('T', ' ').slice(0, 19);

function addInstitution(name, code, settings) {
  const id = Number(db.prepare('INSERT INTO institutions (name, code) VALUES (?, ?)').run(name, code).lastInsertRowid);
  saveSettings(id, settings);
  return id;
}
function addUser(instId, name, email, role, password) {
  return Number(
    db
      .prepare('INSERT INTO users (institution_id, name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(instId, name, email, password ? hash(password) : null, role, createdAt).lastInsertRowid,
  );
}

const officeLat = -1.9441;
const officeLng = 30.0619;
const nga = addInstitution('NGA', 'nga', {
  timezone: TZ,
  officeName: 'Main Office',
  officeLat,
  officeLng,
  radiusMeters: 150,
  workStart: '08:00',
  workEnd: '17:00',
  graceMinutes: 10,
  workDays: [1, 2, 3, 4, 5],
  alertEmails: 'hr@nga.demo',
});
const clinic = addInstitution('Demo Clinic', 'demo-clinic', {
  timezone: 'Africa/Nairobi',
  officeName: 'Clinic',
  officeLat: -1.2864,
  officeLng: 36.8172,
  workStart: '07:30',
  workEnd: '16:30',
});

addUser(nga, 'Head of HR', 'hr@nga.demo', 'admin', 'demo-admin-1');
const staff = [
  ['Eric Mugisha', 'eric@nga.demo', 3],
  ['Grace Iradukunda', 'grace@nga.demo', 0],
  ['Jane Uwase', 'jane@nga.demo', 1],
  ['Patrick Habimana', 'patrick@nga.demo', 2],
  ['Sandrine Mukamana', 'sandrine@nga.demo', 0],
  ['Alice Ingabire', 'alice@nga.demo', 1],
].map(([name, email, lateness]) => ({ id: addUser(nga, name, email, 'employee', 'demo-staff-1'), lateness }));
addUser(nga, 'Kevin Mutabazi', 'kevin@nga.demo', 'employee', null); // shows "Invite pending"

addUser(clinic, 'Clinic Admin', 'admin@clinic.demo', 'admin', 'demo-admin-1');
addUser(clinic, 'Nurse Amani', 'amani@clinic.demo', 'employee', 'demo-staff-1');

// Two weeks of NGA attendance, deterministic so every run looks the same.
let seed = 7;
const rand = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
const today = localParts(new Date(), TZ).date;
const days = dateRange(addDays(today, -15), addDays(today, -1)).filter((d) => [1, 2, 3, 4, 5].includes(weekdayOf(d)));
const toIso = (ymd, minutes) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, minutes - OFFSET_HOURS * 60)).toISOString();
};
const insert = db.prepare(
  `INSERT INTO attendance (user_id, date, check_in_at, check_in_lat, check_in_lng, check_in_distance, check_in_accuracy,
                           late, late_minutes, check_out_at, check_out_lat, check_out_lng, check_out_distance, check_out_accuracy,
                           early, early_minutes)
   VALUES (?, ?, ?, ?, ?, ?, 12, ?, ?, ?, ?, ?, ?, 12, ?, ?)`,
);
for (const day of days) {
  for (const s of staff) {
    if (rand() < 0.06) continue; // absent
    // Most arrive 07:40–08:10; people with higher "lateness" are sometimes very late.
    let inMin = 460 + Math.floor(rand() * 30);
    if (rand() < s.lateness * 0.15) inMin = 490 + Math.floor(rand() * (s.lateness * 45));
    let outMin = 1020 + Math.floor(rand() * 40);
    if (rand() < 0.1) outMin = 900 + Math.floor(rand() * 100);
    const late = inMin > 490;
    const early = outMin < 1020;
    insert.run(
      s.id, day, toIso(day, inMin), officeLat, officeLng, Math.floor(10 + rand() * 80),
      late ? 1 : 0, late ? inMin - 480 : 0,
      toIso(day, outMin), officeLat, officeLng, Math.floor(10 + rand() * 80),
      early ? 1 : 0, early ? 1020 - outMin : 0,
    );
  }
}

console.log('\n=================================================================');
console.log(` DEMO MODE  ·  http://localhost:${PORT}`);
console.log(' Sample data only. Emails and login codes are printed below.');
console.log('-----------------------------------------------------------------');
for (const [who, where, email, pw] of LOGINS) {
  console.log(` ${who.padEnd(18)} ${where.padEnd(13)} ${email.padEnd(20)} ${pw}`);
}
console.log('=================================================================\n');

await import('../index.js');
