// Makes a consistent copy of the live database (safe while the app is running).
//
//   npm run backup --prefix server            uses DB_PATH from the environment / server/.env
//   BACKUP_DIR=/data/backups KEEP=14 npm run backup --prefix server
//
// Backups go to BACKUP_DIR (default: a "backups" folder next to the database) as
// checkin-YYYYMMDD-HHMMSS.db; only the newest KEEP (default 14) are kept.
// The deploy script runs this before every update, so a bad release can be rolled back.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = path.resolve(process.env.DB_PATH || path.join(serverDir, 'data.db'));
if (!fs.existsSync(dbPath)) {
  console.error(`[backup] No database at ${dbPath}. Set DB_PATH.`);
  process.exit(1);
}
const dir = path.resolve(process.env.BACKUP_DIR || path.join(path.dirname(dbPath), 'backups'));
const keep = Number(process.env.KEEP || 14);
fs.mkdirSync(dir, { recursive: true });

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const target = path.join(dir, `checkin-${stamp}.db`);
const source = new DatabaseSync(dbPath, { readOnly: true });
const pages = await backup(source, target);
source.close();

// Make the copy a single self-contained file (no -wal/-shm side files), then sanity-check it.
const check = new DatabaseSync(target);
check.exec('PRAGMA journal_mode = DELETE;');
const institutions = check.prepare('SELECT COUNT(*) c FROM institutions').get().c;
const attendance = check.prepare('SELECT COUNT(*) c FROM attendance').get().c;
check.close();
console.log(`[backup] ${target} (${(fs.statSync(target).size / 1048576).toFixed(1)} MB, ${pages} pages, ${institutions} institutions, ${attendance} attendance records)`);

const old = fs
  .readdirSync(dir)
  .filter((f) => /^checkin-\d{8}-\d{6}\.db$/.test(f))
  .sort()
  .slice(0, -keep);
for (const f of old) for (const s of ['', '-wal', '-shm']) fs.rmSync(path.join(dir, f + s), { force: true });
if (old.length) console.log(`[backup] Removed ${old.length} old backup(s); keeping the newest ${keep}.`);
