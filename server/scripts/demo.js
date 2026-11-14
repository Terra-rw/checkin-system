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
