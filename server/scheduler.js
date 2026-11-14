import { db, getSettings } from './db.js';
import { localParts, toMinutes, addDays } from './time.js';
import { sendMail, alertRecipients } from './mailer.js';
import { runReportJob } from './reportJobs.js';

/** Returns true the first time it is called for (institution, date, kind). */
function claimOnce(instId, date, kind) {
  const r = db
    .prepare('INSERT OR IGNORE INTO notification_log (institution_id, date, kind) VALUES (?, ?, ?)')
    .run(instId, date, kind);
  return r.changes > 0;
}

/**
 * Once per work day, as soon as the late deadline (workStart + grace) passes,
 * email a summary of employees who still haven't checked in.
 */
async function checkNoShows(inst, s, now) {
  if (!s.notifyNoShow || !s.workDays.includes(now.weekday)) return;
  const deadline = toMinutes(s.workStart) + s.graceMinutes;
  if (now.minutes < deadline || now.minutes >= toMinutes(s.workEnd)) return;
  if (!claimOnce(inst.id, now.date, 'no_show')) return;

  const missing = db
    .prepare(
      `SELECT u.name, u.email FROM users u
       WHERE u.institution_id = ? AND u.active = 1 AND u.role = 'employee'
         AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.user_id = u.id AND a.date = ?)
       ORDER BY u.name`,
    )
    .all(inst.id, now.date);
  if (missing.length === 0) return;

  const list = missing.map((m) => `  - ${m.name} <${m.email}>`).join('\n');
  await sendMail({
    to: alertRecipients(s),
    brand: inst,
    subject: `${missing.length} employee(s) not checked in - ${now.date}`,
    text:
      `The following employees had not checked in at ${s.officeName} by ` +
      `${s.workStart} (+${s.graceMinutes} min grace) on ${now.date}:\n\n${list}\n`,
  });

  if (s.emailEmployee) {
    for (const m of missing) {
      await sendMail({
        to: [m.email],
        brand: inst,
        subject: `You have not checked in today (${now.date})`,
        text:
          `Hi ${m.name},\n\nWork starts at ${s.workStart} and you have not checked in at ` +
          `${s.officeName} yet. Please check in as soon as you arrive.\n`,
      });
    }
  }
}

/** Every Monday after the start time: last week's summary (Excel) to the alert emails. */
async function weeklyReport(inst, s, now) {
  if (!s.weeklyReport || now.weekday !== 1 || now.minutes < toMinutes(s.workStart)) return;
  if (!claimOnce(inst.id, now.date, 'weekly_report')) return;
  const from = addDays(now.date, -7);
  const to = addDays(now.date, -1);
  const file = await runReportJob({
    task: 'export',
    format: 'xlsx',
    instId: inst.id,
    generatedBy: 'automatic weekly report',
    query: { type: 'summary', from, to },
  });
  await sendMail({
    to: alertRecipients(s),
    brand: inst,
    subject: `Weekly attendance summary: ${file.period}`,
    text: `Attached is last week's attendance summary for ${inst.name}.\n\n${file.stats.map((x) => `${x.label}: ${x.value}`).join('\n')}\n`,
    attachments: [{ filename: file.fileName, content: Buffer.from(file.buffer) }],
  });
}

async function tick() {
  const institutions = db.prepare("SELECT * FROM institutions WHERE status = 'active'").all();
  for (const inst of institutions) {
    try {
      const s = getSettings(inst.id);
      const now = localParts(new Date(), s.timezone);
      await checkNoShows(inst, s, now);
      await weeklyReport(inst, s, now);
    } catch (err) {
      console.error(`[scheduler] ${inst.code}:`, err);
    }
  }
  // Housekeeping: expired codes and links.
  const now = new Date().toISOString();
  db.prepare('DELETE FROM login_challenges WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM tokens WHERE expires_at < ?').run(now);
}

export function startScheduler() {
  const run = () => tick().catch((err) => console.error('[scheduler]', err));
  run();
  setInterval(run, 60 * 1000);
}
