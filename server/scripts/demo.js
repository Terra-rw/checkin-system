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
fs.rmSync(path.join(serverDir, 'demo-uploads'), { recursive: true, force: true });

const PORT = process.env.PORT || '4500';
Object.assign(process.env, {
  PORT,
  DB_PATH: dbFile,
  UPLOAD_DIR: path.join(serverDir, 'demo-uploads'),
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
  ['NGA manager', `/nga`, 'grace@nga.demo', 'demo-staff-1'],
  ['NGA employee', `/nga`, 'eric@nga.demo', 'demo-staff-1'],
  ['NGA part-timer', `/nga`, 'alice@nga.demo', 'demo-staff-1'],
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
function addUser(instId, name, email, role, password, managerId = null) {
  return Number(
    db
      .prepare('INSERT INTO users (institution_id, name, email, password_hash, role, manager_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(instId, name, email, password ? hash(password) : null, role, managerId, createdAt).lastInsertRowid,
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

const hrId = addUser(nga, 'Head of HR', 'hr@nga.demo', 'admin', 'demo-admin-1');
// Grace manages Eric, Jane and Patrick. Sandrine and Alice report to HR directly.
const graceId = addUser(nga, 'Grace Iradukunda', 'grace@nga.demo', 'manager', 'demo-staff-1');
// pattern: which weekdays they come in and their usual hours (minutes from midnight)
const FULL = { days: [1, 2, 3, 4, 5], start: 480, end: 1020 };
const staff = [
  ['Grace Iradukunda', null, 0, FULL, graceId],
  ['Eric Mugisha', 'eric@nga.demo', 3, FULL],
  ['Jane Uwase', 'jane@nga.demo', 1, FULL],
  ['Patrick Habimana', 'patrick@nga.demo', 2, { days: [1, 3, 5], start: 480, end: 780 }], // part-time, fixed Mon/Wed/Fri 08:00–13:00
  ['Sandrine Mukamana', 'sandrine@nga.demo', 0, { days: [1, 2, 3, 4], start: 480, end: 1020 }], // Fridays off
  ['Alice Ingabire', 'alice@nga.demo', 1, { days: [1, 3, 4], start: 540, end: 780, flexible: true }], // part-time, flexible
].map(([name, email, lateness, pattern, existing]) => ({
  name,
  id: existing || addUser(nga, name, email, 'employee', 'demo-staff-1', ['Eric Mugisha', 'Jane Uwase', 'Patrick Habimana'].includes(name) ? graceId : null),
  lateness,
  pattern,
}));
const byName = Object.fromEntries(staff.map((x) => [x.name.split(' ')[0].toLowerCase(), x.id]));
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
// Contracts, holidays and time off — set before attendance so the sample days line up with them.
const since = addDays(today, -45);
const terms = db.prepare(
  'INSERT INTO work_terms (institution_id, user_id, effective_from, employment_type, contract_minutes, contract_period, schedule, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
);
const nowIso = new Date().toISOString();
terms.run(nga, byName.sandrine, since, 'full_time', null, null, JSON.stringify({ 1: null, 2: null, 3: null, 4: null }), hrId, nowIso);
terms.run(nga, byName.patrick, since, 'part_time', 15 * 60, 'week', JSON.stringify({ 1: ['08:00', '13:00'], 3: ['08:00', '13:00'], 5: ['08:00', '13:00'] }), hrId, nowIso);
terms.run(nga, byName.alice, since, 'part_time', 12 * 60, 'week', null, hrId, nowIso);

const closureDay = days[Math.floor(days.length / 2)];
const holiday = db.prepare('INSERT INTO holidays (institution_id, start_date, end_date, name, kind, yearly, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
holiday.run(nga, closureDay, closureDay, 'Staff retreat (office closed)', 'closure', 0, nowIso);
const year = today.slice(0, 4);
for (const [md, name] of [['01-01', "New Year's Day"], ['02-01', 'Heroes Day'], ['05-01', 'Labour Day'], ['07-01', 'Independence Day'], ['07-04', 'Liberation Day'], ['12-25', 'Christmas Day'], ['12-26', 'Boxing Day']]) {
  holiday.run(nga, `${year}-${md}`, `${year}-${md}`, name, 'public', 1, nowIso);
}

const timeOff = db.prepare(
  `INSERT INTO time_off (institution_id, user_id, type, start_date, end_date, part, arrive_by, leave_from, weekdays, reason, status, requested_by, decided_by, decided_at, decision_note, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const weekdayAfter = (from, n) => {
  let d = from;
  for (let i = 0; i < n; ) if ([1, 2, 3, 4, 5].includes(weekdayOf((d = addDays(d, 1))))) i++;
  return d;
};
const sickFrom = days[days.length - 4];
const sickTo = days[days.length - 3];
const missionDay = days[2];
timeOff.run(nga, byName.jane, 'sick', sickFrom, sickTo, 'full', null, null, null, 'Flu', 'approved', byName.jane, graceId, nowIso, null, nowIso);
timeOff.run(nga, byName.eric, 'mission', missionDay, missionDay, 'full', null, null, null, 'Site visit, Huye office', 'approved', graceId, graceId, nowIso, null, nowIso);
timeOff.run(nga, byName.jane, 'adjusted', since, addDays(today, 60), 'full', '09:30', null, JSON.stringify([1]), 'School run on Mondays', 'approved', graceId, graceId, nowIso, null, nowIso);
timeOff.run(nga, byName.eric, 'personal', weekdayAfter(today, 3), weekdayAfter(today, 4), 'full', null, null, null, 'Family wedding', 'pending', byName.eric, null, null, null, nowIso);
timeOff.run(nga, byName.patrick, 'personal', weekdayAfter(today, 1), weekdayAfter(today, 1), 'am', null, null, null, 'Doctor appointment', 'pending', byName.patrick, null, null, null, nowIso);
timeOff.run(nga, byName.sandrine, 'personal', weekdayAfter(today, 7), weekdayAfter(today, 7), 'full', null, null, null, 'Moving house', 'declined', byName.sandrine, hrId, nowIso, 'Quarter-end closing that day, please pick another', nowIso);
const skip = new Set([...dateRange(sickFrom, sickTo).map((d) => `${byName.jane}|${d}`), `${byName.eric}|${missionDay}`]);

const insert = db.prepare(
  `INSERT INTO attendance (user_id, date, check_in_at, check_in_lat, check_in_lng, check_in_distance, check_in_accuracy,
                           late, late_minutes, check_out_at, check_out_lat, check_out_lng, check_out_distance, check_out_accuracy,
                           early, early_minutes)
   VALUES (?, ?, ?, ?, ?, ?, 12, ?, ?, ?, ?, ?, ?, 12, ?, ?)`,
);
for (const day of days) {
  if (day === closureDay) continue;
  for (const s of staff) {
    const p = s.pattern;
    if (!p.days.includes(weekdayOf(day)) || skip.has(`${s.id}|${day}`)) continue;
    if (rand() < 0.06) continue; // absent
    // Most arrive up to 20 min early or 10 min late; people with higher "lateness" are sometimes very late.
    const start = s.id === byName.jane && weekdayOf(day) === 1 ? 570 : p.start; // Jane's agreed Monday start
    let inMin = start - 20 + Math.floor(rand() * 30);
    if (rand() < s.lateness * 0.15) inMin = start + 10 + Math.floor(rand() * (s.lateness * 45));
    let outMin = p.end + Math.floor(rand() * 40);
    if (rand() < 0.1) outMin = p.end - 120 + Math.floor(rand() * 100);
    const late = !p.flexible && inMin > start + 10;
    const early = !p.flexible && outMin < p.end;
    const startDiff = inMin - start;
    const endDiff = p.end - outMin;
    insert.run(
      s.id, day, toIso(day, inMin), officeLat, officeLng, Math.floor(10 + rand() * 80),
      late ? 1 : 0, late ? startDiff : 0,
      toIso(day, outMin), officeLat, officeLng, Math.floor(10 + rand() * 80),
      early ? 1 : 0, early ? endDiff : 0,
    );
  }
}

// A forgotten check-out (Alice, last working day) and a fixed one with its audit trail (Eric).
const lastDay = days[days.length - 1];
const aliceDay = [...days].reverse().find((d) => staff.find((x) => x.id === byName.alice).pattern.days.includes(weekdayOf(d)) && d !== closureDay);
db.prepare('UPDATE attendance SET check_out_at = NULL, check_out_lat = NULL, check_out_lng = NULL, check_out_distance = NULL, early = 0, early_minutes = 0 WHERE user_id = ? AND date = ?').run(byName.alice, aliceDay);
const ericRec = db.prepare('SELECT * FROM attendance WHERE user_id = ? AND date = ?').get(byName.eric, lastDay);
if (ericRec) {
  const fixedOut = toIso(lastDay, 1035);
  db.prepare("UPDATE attendance SET check_out_at = ?, early = 0, early_minutes = 0, source = 'edited' WHERE id = ?").run(fixedOut, ericRec.id);
  db.prepare(
    'INSERT INTO attendance_corrections (institution_id, attendance_id, changed_by, field, old_value, new_value, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(nga, ericRec.id, graceId, 'check_out', null, fixedOut, 'Phone died before checking out; confirmed with reception', nowIso);
}

// ---------------------------------------------------------------- sample branding for NGA
// Simple images drawn pixel by pixel so the demo needs no image files or libraries.
const zlib = await import('node:zlib');
const { saveImage } = await import('../media.js');

function canvas(w, h, bg) {
  const px = new Uint8Array(w * h * 4);
  const set = (x, y, [r, g, b, a = 255]) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const o = (y * w + x) * 4;
    px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = a;
  };
  const fill = (test, color) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (test(x, y)) set(x, y, color);
  };
  if (bg) fill(() => true, bg);
  const toPng = () => {
    const chunk = (type, data) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const td = Buffer.concat([Buffer.from(type), data]);
      const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
      return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
    const raw = Buffer.alloc((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) Buffer.from(px.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
  };
  return { fill, toPng };
}
const nearSegment = (x, y, [x1, y1], [x2, y2], r) => {
  const dx = x2 - x1, dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
  return (x - x1 - t * dx) ** 2 + (y - y1 - t * dy) ** 2 <= r * r;
};

// Logo: teal shield with two chevrons, transparent background (256 px).
const logo = canvas(256, 256);
const inShield = (x, y) => {
  const u = (x - 128) / 96; // -1..1 across
  const v = (y - 16) / 224; // 0..1 down
  if (v < 0 || v > 1) return false;
  if (v < 0.5) return Math.abs(u) <= 1 - Math.max(0, 0.12 - v) * 2;
  return Math.abs(u) <= Math.sqrt(Math.max(0, 1 - ((v - 0.5) / 0.5) ** 2));
};
logo.fill(inShield, [15, 118, 110]);
logo.fill((x, y) => nearSegment(x, y, [80, 112], [128, 80], 9) || nearSegment(x, y, [128, 80], [176, 112], 9), [255, 255, 255]);
logo.fill((x, y) => nearSegment(x, y, [80, 160], [128, 128], 9) || nearSegment(x, y, [128, 128], [176, 160], 9), [245, 196, 81]);

// Photo: flat illustration of a campus building (1280 × 560).
const photo = canvas(1280, 560, [207, 227, 234]);
photo.fill((x, y) => (x - 1040) ** 2 + (y - 128) ** 2 < 60 ** 2, [243, 227, 181]);
photo.fill((x, y) => y >= 432, [156, 185, 138]);
photo.fill((x, y) => x >= 272 && x < 1008 && y >= 192 && y < 448, [232, 220, 200]);
photo.fill((x, y) => x >= 240 && x < 1040 && y >= 160 && y < 202, [185, 166, 136]);
photo.fill((x, y) => x >= 576 && x < 704 && y >= 304 && y < 448, [125, 107, 85]);
for (const wx of [320, 448, 752, 880]) for (const wy of [240, 336]) photo.fill((x, y) => x >= wx && x < wx + 80 && y >= wy && y < wy + 54, [93, 127, 147]);
for (const [cx, cy, r] of [[144, 400, 70], [1152, 394, 80], [208, 432, 48]]) photo.fill((x, y) => (x - cx) ** 2 + (y - cy) ** 2 < r * r, [95, 138, 79]);

const logoFile = saveImage(nga, 'logo', logo.toPng()).name;
const photoFile = saveImage(nga, 'photo', photo.toPng()).name;
db.prepare('UPDATE institutions SET logo_file = ?, photo_file = ?, photo_focus_x = 50, photo_focus_y = 55 WHERE id = ?').run(logoFile, photoFile, nga);

console.log('\n=================================================================');
console.log(` DEMO MODE  ·  http://localhost:${PORT}`);
console.log(' Sample data only. Emails and login codes are printed below.');
console.log('-----------------------------------------------------------------');
for (const [who, where, email, pw] of LOGINS) {
  console.log(` ${who.padEnd(18)} ${where.padEnd(13)} ${email.padEnd(20)} ${pw}`);
}
console.log('=================================================================\n');

await import('../index.js');
