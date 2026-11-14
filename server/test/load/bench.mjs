// Load benchmark: measures the server's CPU time and memory per kind of request.
//
//   npm run bench                       (2,000 employees, 30 days of history)
//   npm run bench -- --employees 5000   (bigger institution)
//
// It seeds a throwaway database in a temp folder, starts the real server as a child process
// and reads THAT process's CPU time from the OS (Linux /proc, macOS ps, Windows PowerShell),
// so the load generator's own CPU isn't counted. Run it on the target machine (e.g. the AWS
// instance) to size it with real numbers. Requires the client to be built (npm run build).
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { SERVER_DIR } from '../helpers.mjs';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : def;
};
const EMPLOYEES = arg('employees', 2000);
const DAYS = arg('days', 30);
const TZ = 'Africa/Kigali';
const SECRET = 'bench-secret';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- seed
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-bench-'));
const dbPath = path.join(dir, 'bench.db');
const dist = path.join(SERVER_DIR, '..', 'client', 'dist', 'index.html');
if (!fs.existsSync(dist)) {
  console.error('Build the client first: npm run build (from the project root).');
  process.exit(1);
}
process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = path.join(dir, 'uploads');
const { db, saveSettings, tx } = await import('../../db.js');
const { dateRange, weekdayOf, addDays, localParts } = await import('../../time.js');

console.log(`Seeding ${EMPLOYEES} employees with ${DAYS} days of history…`);
const hash = bcrypt.hashSync('bench-pass-1', 10);
const inst = Number(db.prepare("INSERT INTO institutions (name, code) VALUES ('Bench', 'bench')").run().lastInsertRowid);
saveSettings(inst, {
  timezone: TZ, officeLat: -1.9441, officeLng: 30.0619, radiusMeters: 150, workStart: '08:00', workEnd: '17:00',
  graceMinutes: 10, workDays: [0, 1, 2, 3, 4, 5, 6], alertEmails: '', emailEmployee: false,
  notifyEarlyCheckout: false, notifyNoShow: false, require2fa: false,
});
const insUser = db.prepare("INSERT INTO users (institution_id, name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, '2026-01-01 00:00:00')");
const insAtt = db.prepare(
  `INSERT INTO attendance (user_id, date, check_in_at, check_in_lat, check_in_lng, check_in_distance, check_in_accuracy,
     late, late_minutes, check_out_at, check_out_lat, check_out_lng, check_out_distance, check_out_accuracy, early, early_minutes)
   VALUES (?, ?, ?, -1.9441, 30.0619, 40, 12, ?, ?, ?, -1.9441, 30.0619, 40, 12, ?, ?)`,
);
const today = localParts(new Date(), TZ).date;
const days = dateRange(addDays(today, -DAYS), addDays(today, -1)).filter((d) => ![0, 6].includes(weekdayOf(d)));
let adminId;
const ids = [];
tx(() => {
  adminId = Number(insUser.run(inst, 'Bench Admin', 'admin@bench.test', hash, 'admin').lastInsertRowid);
  for (let i = 0; i < EMPLOYEES; i++) ids.push(Number(insUser.run(inst, `Employee ${i}`, `e${i}@bench.test`, hash, 'employee').lastInsertRowid));
  let seed = 3;
  const rand = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  for (const d of days) {
    const [y, m, dd] = d.split('-').map(Number);
    const iso = (min) => new Date(Date.UTC(y, m - 1, dd, 0, min - 120)).toISOString();
    for (const id of ids) {
      if (rand() < 0.05) continue;
      const inMin = 465 + Math.floor(rand() * 40);
      const outMin = 1010 + Math.floor(rand() * 40);
      insAtt.run(id, d, iso(inMin), inMin > 490 ? 1 : 0, inMin > 490 ? inMin - 480 : 0, iso(outMin), outMin < 1020 ? 1 : 0, outMin < 1020 ? 1020 - outMin : 0);
    }
  }
});
console.log(`  ${db.prepare('SELECT COUNT(*) c FROM attendance').get().c} attendance rows`);
db.close();

// ---------------------------------------------------------------- server + process stats
const PORT = 4800 + Math.floor(Math.random() * 100);
const BASE = `http://localhost:${PORT}`;
let log = '';
const srv = spawn(process.execPath, ['index.js'], {
  cwd: SERVER_DIR,
  env: { ...process.env, PORT: String(PORT), DB_PATH: dbPath, UPLOAD_DIR: path.join(dir, 'uploads'), JWT_SECRET: SECRET, SMTP_HOST: '', APP_URL: BASE },
});
srv.stdout.on('data', (d) => (log += d));
srv.stderr.on('data', (d) => (log += d));
for (let i = 0; i < 120 && !log.includes('running on'); i++) await sleep(250);

const TICK = process.platform === 'linux' ? Number(execFileSync('getconf', ['CLK_TCK']).toString()) || 100 : 100;
function proc() {
  const pid = srv.pid;
  if (process.platform === 'linux') {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const kb = (k) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(status)?.[1] || 0);
    return { cpuMs: ((Number(stat[11]) + Number(stat[12])) / TICK) * 1000, rss: kb('VmRSS') * 1024, peak: kb('VmHWM') * 1024 };
  }
  if (process.platform === 'win32') {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', `$p=Get-Process -Id ${pid}; "$($p.TotalProcessorTime.TotalMilliseconds) $($p.WorkingSet64) $($p.PeakWorkingSet64)"`]).toString().trim().split(/\s+/);
    return { cpuMs: Number(out[0]), rss: Number(out[1]), peak: Number(out[2]) };
  }
  const [cpu, rss] = execFileSync('ps', ['-o', 'cputime=,rss=', '-p', String(pid)]).toString().trim().split(/\s+/);
  const [h, m, s] = cpu.split(':').map(Number);
  return { cpuMs: ((h * 60 + m) * 60 + s) * 1000, rss: Number(rss) * 1024, peak: Number(rss) * 1024 };
}

const token = (id) => jwt.sign({ sub: id, tv: 0 }, SECRET, { expiresIn: '1h' });
const adminTok = token(adminId);
const monthAgo = addDays(today, -30);
const weekAgo = addDays(today, -6);
const asset = /src="(\/assets\/[^"]+\.js)"/.exec(fs.readFileSync(dist, 'utf8'))[1];

async function req(method, url, { tok, body } = {}) {
  const t = performance.now();
  const res = await fetch(BASE + url, {
    method,
    headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const buf = await res.arrayBuffer();
  if (res.status >= 400) throw new Error(`${method} ${url} -> ${res.status} ${Buffer.from(buf).toString().slice(0, 160)}`);
  return performance.now() - t;
}

const rows = [];
async function scenario(name, n, conc, fn) {
  try {
    await fn(0);
    const before = proc();
    const lat = [];
    let next = 1;
    await Promise.all(Array.from({ length: conc }, async () => { while (next <= n) lat.push(await fn(next++)); }));
    const after = proc();
    lat.sort((a, b) => a - b);
    const row = {
      scenario: name,
      'CPU ms/request': +((after.cpuMs - before.cpuMs) / n).toFixed(2),
      'p50 ms': +lat[Math.floor(lat.length / 2)].toFixed(1),
      'p95 ms': +lat[Math.floor(lat.length * 0.95)].toFixed(1),
      'memory MB': Math.round(after.rss / 1048576),
    };
    rows.push(row);
    console.log(`  ${name}: ${row['CPU ms/request']} ms CPU`);
  } catch (e) {
    rows.push({ scenario: name, 'CPU ms/request': 'error', 'p50 ms': String(e.message).slice(0, 60) });
  }
}

console.log(`Benchmarking on ${os.cpus()[0].model} (${os.cpus().length} threads), Node ${process.version}…`);
let ci = 0;
let co = 0;
const n = Math.min(EMPLOYEES, 2000);
await scenario('static index.html', 1000, 20, () => req('GET', '/'));
await scenario('static JS bundle', 300, 10, () => req('GET', asset));
await scenario('login (password check)', 50, 4, () => req('POST', '/api/auth/login', { body: { institution: 'bench', email: 'e1@bench.test', password: 'bench-pass-1' } }));
await scenario('page load (/api/me)', 2000, 20, (i) => req('GET', '/api/me', { tok: token(ids[i % ids.length]) }));
await scenario('check-in', n - 1, 20, () => req('POST', '/api/attendance/check-in', { tok: token(ids[ci++]), body: { lat: -1.9442, lng: 30.062, accuracy: 10 } }));
await scenario('check-out', n - 1, 20, () => req('POST', '/api/attendance/check-out', { tok: token(ids[co++]), body: { lat: -1.9442, lng: 30.062, accuracy: 10 } }));
await scenario(`admin today list (${EMPLOYEES} people)`, 50, 4, () => req('GET', `/api/admin/attendance?from=${today}&to=${today}`, { tok: adminTok }));
await scenario('report preview: month summary', 10, 1, () => req('GET', `/api/admin/reports?type=summary&from=${monthAgo}&to=${today}`, { tok: adminTok }));
await scenario('report PDF: month summary', 5, 1, () => req('GET', `/api/admin/reports?type=summary&from=${monthAgo}&to=${today}&format=pdf`, { tok: adminTok }));
await scenario('report Excel: month daily log', 3, 1, () => req('GET', `/api/admin/reports?type=daily&from=${monthAgo}&to=${today}&format=xlsx`, { tok: adminTok }));

// Page loads while a big export runs (reports run in a background worker).
const heavy = req('GET', `/api/admin/reports?type=daily&from=${monthAgo}&to=${today}&format=xlsx`, { tok: adminTok });
const during = [];
const stopAt = Date.now() + 2500;
while (Date.now() < stopAt) during.push(await req('GET', '/api/me', { tok: token(ids[during.length % ids.length]) }));
await heavy;
during.sort((a, b) => a - b);
const end = proc();

console.log('');
console.table(rows);
console.log(`Page loads during a big export: p50 ${during[Math.floor(during.length / 2)].toFixed(1)} ms, max ${during.at(-1).toFixed(1)} ms`);
console.log(`Peak server memory: ${Math.round(end.peak / 1048576)} MB`);
console.log('\nSizing rule of thumb: (CPU ms per arriving employee) x (arrivals per second at peak) should stay under ~500 ms per second (50% of one core).');

srv.kill();
await sleep(300);
fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
