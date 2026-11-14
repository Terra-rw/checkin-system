import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { db, getSettings, logEvent, normalizeCode, tx } from './db.js';
import { sendMail } from './mailer.js';
import { formatTime } from './time.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.warn('[auth] JWT_SECRET not set: using a random one (everyone is logged out on restart).');
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
}
if (!process.env.APP_URL) {
  console.warn('[auth] APP_URL not set: email links will use the address of each request. Set APP_URL in production.');
}

const MAX_CODE_ATTEMPTS = 5;
const MAX_PASSWORD_ATTEMPTS = 10;
const LOCK_MINUTES = 15;
const RESEND_SECONDS = 45;
export const MIN_PASSWORD = 8;

// ---------------------------------------------------------------- small helpers

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');
const nowIso = () => new Date().toISOString();
const inMinutes = (min) => new Date(Date.now() + min * 60000).toISOString();

export function appUrl(req) {
  return (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

export const publicUser = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  active: !!u.active,
  invitePending: !u.password_hash,
});
export const publicInstitution = (i) => i && { id: i.id, name: i.name, code: i.code, status: i.status };

export function validatePassword(p) {
  if (typeof p !== 'string' || p.length < MIN_PASSWORD) {
    throw new HttpError(400, `Password must be at least ${MIN_PASSWORD} characters.`);
  }
}

/** "Chrome on Android" from a User-Agent header. */
export function deviceLabel(ua = '') {
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser';
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone/.test(ua)
      ? 'iPhone'
      : /iPad/.test(ua)
        ? 'iPad'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Mac OS X/.test(ua)
            ? 'Mac'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'unknown device';
  return `${browser} on ${os}`;
}

const institutionById = (id) => db.prepare('SELECT * FROM institutions WHERE id = ?').get(id);
export const institutionByCode = (code) =>
  db.prepare('SELECT * FROM institutions WHERE code = ?').get(normalizeCode(code));

function findLoginUser(institutionCode, email) {
  email = String(email || '').trim().toLowerCase();
  if (!institutionCode) {
    return { inst: null, user: db.prepare("SELECT * FROM users WHERE role = 'owner' AND email = ?").get(email) };
  }
  const inst = institutionByCode(institutionCode);
  if (!inst) throw new HttpError(404, 'That institution was not found. Check the link you were given.');
  if (inst.status !== 'active') throw new HttpError(403, `${inst.name} is currently suspended. Contact your administrator.`);
  const user = db
    .prepare("SELECT * FROM users WHERE institution_id = ? AND email = ? AND role != 'owner'")
    .get(inst.id, email);
  return { inst, user };
}

function issueSession(user, inst, extra = {}) {
  const token = jwt.sign({ sub: user.id, tv: user.token_version, ...extra }, JWT_SECRET, { expiresIn: extra.support ? '1h' : '30d' });
  return { token, user: publicUser(user), institution: publicInstitution(inst) };
}

/** Short-lived admin session the platform owner uses to help an institution. */
export function issueSupportSession(owner, inst) {
  return issueSession(owner, inst, { support: inst.id });
}

function lockedMessage(user) {
  if (!user.locked_until || user.locked_until <= nowIso()) return null;
  const mins = Math.ceil((new Date(user.locked_until) - Date.now()) / 60000);
  return `Too many failed attempts. This account is locked for ${mins} more min.`;
}

function lockUser(user, inst, reason) {
  db.prepare('UPDATE users SET locked_until = ?, failed_logins = 0 WHERE id = ?').run(inMinutes(LOCK_MINUTES), user.id);
  logEvent(inst?.id, user.id, 'locked', `${reason} for ${user.email}. Locked for ${LOCK_MINUTES} min.`);
  sendMail({
    to: [user.email],
    fromName: inst?.name,
    subject: 'Your check-in account was locked',
    text:
      `Hi ${user.name},\n\n${reason}, so your account is locked for ${LOCK_MINUTES} minutes.\n\n` +
      `If this wasn't you, someone may know your password. Use "Forgot password" on the login page to change it.\n`,
  });
}

function settingsFor(inst) {
  return inst ? getSettings(inst.id) : { require2fa: true, trustDays: 30, codeMinutes: 10, resetMinutes: 30, timezone: 'UTC' };
}

// ---------------------------------------------------------------- trusted devices & codes

function isTrustedDevice(user, deviceToken) {
  if (!deviceToken) return false;
  const row = db
    .prepare("SELECT id FROM tokens WHERE user_id = ? AND kind = 'device' AND token_hash = ? AND expires_at > ?")
    .get(user.id, sha256(deviceToken), nowIso());
  if (!row) return false;
  db.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?').run(nowIso(), row.id);
  return true;
}

function sendCode(challengeId, user, inst, label) {
  const s = settingsFor(inst);
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  db.prepare('UPDATE login_challenges SET code_hash = ?, last_sent_at = ?, expires_at = ? WHERE id = ?').run(
    sha256(challengeId + code),
    nowIso(),
    inMinutes(s.codeMinutes),
    challengeId,
  );
  const when = `${formatTime(new Date(), s.timezone)} (${s.timezone})`;
  sendMail({
    to: [user.email],
    fromName: inst?.name,
    subject: `${code} is your ${inst ? inst.name + ' ' : ''}check-in code`,
    text:
      `Hi ${user.name},\n\nEnter this code to finish logging in on a new device:\n\n    ${code}\n\n` +
      `Device: ${label}\nTime:   ${when}\n\n` +
      `It expires in ${s.codeMinutes} minutes. If this wasn't you, change your password straight away.\n`,
  });
}

function maskEmail(email) {
  const [name, domain] = email.split('@');
  return `${name.slice(0, 1)}•••@${domain}`;
}

/** Creates a reset or invite link and emails it. */
export function sendPasswordLink(req, user, inst, kind) {
  const s = settingsFor(inst);
  const token = randomToken();
  const minutes = kind === 'invite' ? 7 * 24 * 60 : s.resetMinutes;
  db.prepare("DELETE FROM tokens WHERE user_id = ? AND kind IN ('reset', 'invite') AND used_at IS NULL").run(user.id);
  db.prepare('INSERT INTO tokens (user_id, kind, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(
    user.id,
    kind,
    sha256(token),
    nowIso(),
    inMinutes(minutes),
  );
  const link = `${appUrl(req)}/${inst ? inst.code : 'platform'}/reset?token=${token}`;
  const where = inst ? inst.name : 'the check-in platform';

  if (kind === 'invite') {
    return sendMail({
      to: [user.email],
      fromName: inst?.name,
      subject: `You've been invited to ${where} check-in`,
      text:
        `Hi ${user.name},\n\nAn account has been created for you on ${where}'s check-in system.\n` +
        `Choose your password here to get started:\n\n${link}\n\nThis link expires in 7 days.\n`,
    });
  }
  return sendMail({
    to: [user.email],
    fromName: inst?.name,
    subject: `Reset your ${inst ? inst.name + ' ' : ''}check-in password`,
    text:
      `Hi ${user.name},\n\nSomeone asked to reset the password for ${user.email}. If it was you, choose a new password here:\n\n` +
      `${link}\n\nThe link works once and expires in ${minutes} minutes.\n` +
      `Didn't ask for this? You can ignore this email. Your password won't change.\n`,
  });
}

function findLinkToken(token) {
  if (!token) return null;
  const row = db
    .prepare("SELECT * FROM tokens WHERE token_hash = ? AND kind IN ('reset', 'invite') AND used_at IS NULL AND expires_at > ?")
    .get(sha256(token), nowIso());
  if (!row) return null;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  if (!user || !user.active) return null;
  return { row, user, inst: user.institution_id ? institutionById(user.institution_id) : null };
}

// ---------------------------------------------------------------- middleware

export function requireAuth(req, _res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    throw new HttpError(401, 'Please log in.');
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
  if (!user || !user.active || payload.tv !== user.token_version) throw new HttpError(401, 'Please log in again.');

  if (user.role === 'owner') {
    if (payload.support) {
      const inst = institutionById(payload.support);
      if (!inst) throw new HttpError(401, 'Please log in again.');
      req.user = { ...user, role: 'admin', support: true };
      req.inst = inst;
    } else {
      req.user = user;
      req.inst = null;
    }
  } else {
    const inst = institutionById(user.institution_id);
    if (!inst || inst.status !== 'active') throw new HttpError(403, 'This institution is currently suspended.');
    req.user = user;
    req.inst = inst;
  }
  next();
}

export function requireInstitution(req, _res, next) {
  if (!req.inst) throw new HttpError(403, 'Open an institution first.');
  next();
}

export function requireAdmin(req, _res, next) {
  if (req.user.role !== 'admin' || !req.inst) throw new HttpError(403, 'Admins only.');
  next();
}

export function requireOwner(req, _res, next) {
  if (req.user.role !== 'owner' || req.user.support) throw new HttpError(403, 'Platform owner only.');
  next();
}

// ---------------------------------------------------------------- routes

export const authRouter = express.Router();

authRouter.get('/institution/:code', (req, res) => {
  const inst = institutionByCode(req.params.code);
  if (!inst) throw new HttpError(404, 'That institution was not found. Check the link you were given.');
  if (inst.status !== 'active') throw new HttpError(403, `${inst.name} is currently suspended.`);
  res.json(publicInstitution(inst));
});

/** If only one institution is active, the home page can jump straight to it. */
authRouter.get('/home', (_req, res) => {
  const rows = db.prepare("SELECT code FROM institutions WHERE status = 'active' LIMIT 2").all();
  res.json({ single: rows.length === 1 ? rows[0].code : null });
});

authRouter.post('/login', (req, res) => {
  const { inst, user } = findLoginUser(req.body.institution, req.body.email);
  if (user) {
    const locked = lockedMessage(user);
    if (locked) throw new HttpError(423, locked);
  }
  if (!user || !user.password_hash || !bcrypt.compareSync(String(req.body.password || ''), user.password_hash)) {
    if (user) {
      const fails = user.failed_logins + 1;
      if (fails >= MAX_PASSWORD_ATTEMPTS) lockUser(user, inst, `${fails} wrong passwords in a row`);
      else db.prepare('UPDATE users SET failed_logins = ? WHERE id = ?').run(fails, user.id);
    }
    if (user && !user.password_hash) {
      throw new HttpError(401, "You haven't set a password yet. Use the link in your invite email, or Forgot password.");
    }
    throw new HttpError(401, 'Wrong email or password.');
  }
  if (!user.active) throw new HttpError(403, 'Your account is disabled.');
  db.prepare('UPDATE users SET failed_logins = 0 WHERE id = ?').run(user.id);

  const s = settingsFor(inst);
  const needsCode = user.role === 'owner' || s.require2fa;
  if (needsCode && !isTrustedDevice(user, req.body.deviceToken)) {
    const id = randomToken();
    const label = deviceLabel(req.get('user-agent'));
    db.prepare(
      'INSERT INTO login_challenges (id, user_id, code_hash, label, last_sent_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, user.id, '', label, nowIso(), nowIso());
    sendCode(id, user, inst, label);
    return res.json({
      challenge: id,
      emailHint: maskEmail(user.email),
      trustDays: s.trustDays,
      codeMinutes: s.codeMinutes,
      resendSeconds: RESEND_SECONDS,
    });
  }
  res.json(issueSession(user, inst));
});

function loadChallenge(id) {
  const ch = id && db.prepare('SELECT * FROM login_challenges WHERE id = ?').get(String(id));
  if (!ch || ch.expires_at <= nowIso()) {
    if (ch) db.prepare('DELETE FROM login_challenges WHERE id = ?').run(ch.id);
    throw new HttpError(400, 'This code has expired. Log in again to get a new one.');
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(ch.user_id);
  const inst = user.institution_id ? institutionById(user.institution_id) : null;
  return { ch, user, inst };
}

authRouter.post('/verify', (req, res) => {
  const { ch, user, inst } = loadChallenge(req.body.challenge);
  const locked = lockedMessage(user);
  if (locked) throw new HttpError(423, locked);

  const code = String(req.body.code || '').replace(/\D/g, '');
  if (sha256(ch.id + code) !== ch.code_hash) {
    const attempts = ch.attempts + 1;
    if (attempts >= MAX_CODE_ATTEMPTS) {
      db.prepare('DELETE FROM login_challenges WHERE id = ?').run(ch.id);
      lockUser(user, inst, `${attempts} wrong device codes`);
      throw new HttpError(423, `Too many wrong codes. Your account is locked for ${LOCK_MINUTES} min.`);
    }
    db.prepare('UPDATE login_challenges SET attempts = ? WHERE id = ?').run(attempts, ch.id);
    const left = MAX_CODE_ATTEMPTS - attempts;
    throw new HttpError(400, `That code isn't right. ${left} ${left === 1 ? 'try' : 'tries'} left.`);
  }

  db.prepare('DELETE FROM login_challenges WHERE id = ?').run(ch.id);
  let deviceToken = null;
  if (req.body.trust) {
    deviceToken = randomToken();
    db.prepare(
      "INSERT INTO tokens (user_id, kind, token_hash, label, created_at, expires_at, last_used_at) VALUES (?, 'device', ?, ?, ?, ?, ?)",
    ).run(user.id, sha256(deviceToken), ch.label, nowIso(), inMinutes(settingsFor(inst).trustDays * 24 * 60), nowIso());
  }
  logEvent(inst?.id, user.id, 'new_device', `${user.name} verified ${ch.label} with an email code${req.body.trust ? '' : ' (not trusted)'}.`);
  res.json({ ...issueSession(user, inst), deviceToken });
});

authRouter.post('/resend', (req, res) => {
  const { ch, user, inst } = loadChallenge(req.body.challenge);
  const wait = RESEND_SECONDS - Math.floor((Date.now() - new Date(ch.last_sent_at)) / 1000);
  if (wait > 0) throw new HttpError(429, `Please wait ${wait} seconds before asking for another code.`);
  sendCode(ch.id, user, inst, ch.label);
  res.json({ message: 'A new code is on its way.', resendSeconds: RESEND_SECONDS });
});

authRouter.post('/forgot', (req, res) => {
  const { inst, user } = findLoginUser(req.body.institution, req.body.email);
  if (user && user.active) {
    const recent = db
      .prepare("SELECT 1 FROM tokens WHERE user_id = ? AND kind = 'reset' AND created_at > ?")
      .get(user.id, new Date(Date.now() - 60000).toISOString());
    if (!recent) {
      sendPasswordLink(req, user, inst, 'reset');
      logEvent(inst?.id, user.id, 'password_reset_requested', `Password reset link sent to ${user.email}.`);
    }
  }
  // Same answer either way, so this can't be used to find out who has an account.
  res.json({ ok: true });
});

authRouter.get('/link', (req, res) => {
  const found = findLinkToken(req.query.token);
  if (!found) return res.json({ valid: false });
  res.json({
    valid: true,
    kind: found.row.kind,
    email: found.user.email,
    name: found.user.name,
    institution: publicInstitution(found.inst),
  });
});

authRouter.post('/reset', (req, res) => {
  const found = findLinkToken(req.body.token);
  if (!found) throw new HttpError(400, 'This link no longer works. Request a new one.');
  const { row, user, inst } = found;
  validatePassword(req.body.password);
  if (user.password_hash && bcrypt.compareSync(req.body.password, user.password_hash)) {
    throw new HttpError(400, 'Choose a password that is different from your old one.');
  }
  tx(() => {
    db.prepare(
      'UPDATE users SET password_hash = ?, token_version = token_version + 1, failed_logins = 0, locked_until = NULL WHERE id = ?',
    ).run(bcrypt.hashSync(req.body.password, 10), user.id);
    db.prepare('UPDATE tokens SET used_at = ? WHERE id = ?').run(nowIso(), row.id);
    db.prepare("DELETE FROM tokens WHERE user_id = ? AND (kind = 'device' OR (used_at IS NULL AND kind != 'device'))").run(user.id);
  });
  logEvent(
    inst?.id,
    user.id,
    row.kind === 'invite' ? 'invite_accepted' : 'password_reset',
    row.kind === 'invite' ? `${user.name} set a password and joined.` : `${user.name} reset their password using an emailed link.`,
  );
  res.json({ message: row.kind === 'invite' ? 'Your password is set. You can log in now.' : 'Password changed. Log in with your new password.' });
});

