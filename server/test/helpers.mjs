// Shared helpers for the end-to-end tests. Each test file starts a real server
// on a throwaway database in a temp folder; emails are captured from its console output.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const SERVER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Starts the server on a fresh temp database. `prepare(dir, dbPath)` can create files first. */
export async function startServer({ env = {}, prepare } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-test-'));
  const dbPath = path.join(dir, 'test.db');
  if (prepare) await prepare(dir, dbPath);
  const port = 4200 + Math.floor(Math.random() * 700);
  const state = { log: '' };
  const child = spawn(process.execPath, ['index.js'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbPath,
      UPLOAD_DIR: path.join(dir, 'uploads'),
      JWT_SECRET: 'test-secret',
      APP_URL: 'http://localhost:5173',
      SMTP_HOST: '',
      PLATFORM_OWNER_EMAIL: 'owner@test.local',
      PLATFORM_OWNER_PASSWORD: 'ownerpass1',
      ...env,
    },
  });
  child.stdout.on('data', (d) => (state.log += d));
  child.stderr.on('data', (d) => (state.log += d));
  for (let i = 0; i < 120 && !state.log.includes('running on'); i++) await sleep(250);
  if (!state.log.includes('running on')) throw new Error(`Server did not start:\n${state.log}`);

  const base = `http://localhost:${port}`;
  async function call(method, p, body, token, raw = false) {
    const res = await fetch(base + '/api' + p, {
      method,
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (raw) return res;
    return { status: res.status, data: await res.json().catch(() => ({})) };
  }
  return {
    base,
    port,
    dir,
    dbPath,
    call,
    get log() {
      return state.log;
    },
    lastCode: () => [...state.log.matchAll(/Enter this code[^\n]*\n\n\s+(\d{6})/g)].pop()?.[1],
    lastLink: () => [...state.log.matchAll(/token=([A-Za-z0-9_-]+)/g)].pop()?.[1],
    async stop() {
      child.kill();
      await sleep(300);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

/** Logs in, answering the email code from the server log when one is asked. */
export async function loginWithCode(srv, institution, email, password, trust = false) {
  let x = await srv.call('POST', '/auth/login', { institution, email, password });
  if (x.data.token) return x.data;
  if (!x.data.challenge) throw new Error(`login failed for ${email}: ${JSON.stringify(x.data)}`);
  x = await srv.call('POST', '/auth/verify', { challenge: x.data.challenge, code: srv.lastCode(), trust });
  return x.data;
}

/** Minimal assertion reporter. */
export function reporter(title) {
  let failures = 0;
  let passes = 0;
  console.log(`\n=== ${title}`);
  return {
    check(name, cond, extra = '') {
      console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`);
      if (cond) passes++;
      else failures++;
    },
    fail(err) {
      console.error('TEST CRASH', err);
      failures++;
    },
    done(srv) {
      const errors = (srv?.log || '').split('\n').filter((l) => /Error|error/.test(l) && !/\[email\]/.test(l));
      if (errors.length) console.log('--- server errors:\n' + errors.join('\n'));
      console.log(failures ? `${failures} FAILED, ${passes} passed` : `ALL ${passes} PASSED`);
      return failures;
    },
  };
}

/** A real (tiny) PNG image of the given size. */
export function makePng(w, h) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = 15;
      raw[o + 1] = 118;
      raw[o + 2] = 110;
    }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export const kigaliDate = (offsetDays = 0) =>
  new Date(Date.now() + offsetDays * 864e5).toLocaleDateString('en-CA', { timeZone: 'Africa/Kigali' });
