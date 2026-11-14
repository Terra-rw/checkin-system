// Uploaded institution logos and photos.
// Files are stored in UPLOAD_DIR (default: an "uploads" folder next to the database, so on
// Render they sit on the same persistent disk) under random names the server chooses.
// They are served read-only from /media with long caching; a new upload gets a new name.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dbPath } from './db.js';

export const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(path.dirname(dbPath), 'uploads'));
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const LIMITS = {
  logo: 1024 * 1024, // the browser shrinks logos to 512 px before upload
  photo: 3 * 1024 * 1024, // and photos to 1920 px wide
};

/** Identifies PNG or JPEG from the file's first bytes; anything else is rejected. */
export function detectImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { ext: 'png', type: 'image/png' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', type: 'image/jpeg' };
  return null;
}

export function saveImage(instId, kind, buf) {
  const info = detectImage(buf);
  if (!info) return { error: 'Upload a PNG or JPG image.' };
  if (buf.length > LIMITS[kind]) return { error: `That image is too large (max ${LIMITS[kind] / 1024 / 1024} MB).` };
  const name = `inst${instId}-${kind}-${crypto.randomBytes(8).toString('hex')}.${info.ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return { name };
}

/** Absolute path of a stored file, or null. Only names this server generated are accepted. */
export function filePath(name) {
  if (!name || !/^inst\d+-(logo|photo)-[0-9a-f]{16}\.(png|jpg)$/.test(name)) return null;
  const p = path.join(UPLOAD_DIR, name);
  return fs.existsSync(p) ? p : null;
}

export function removeFile(name) {
  const p = filePath(name);
  if (p) fs.rmSync(p, { force: true });
}

export const mediaUrl = (name) => (name ? `/media/${name}` : null);
