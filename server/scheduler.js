import { db, getSettings } from './db.js';
import { localParts, toMinutes } from './time.js';
import { sendMail, alertRecipients } from './mailer.js';

/**
 * Once per work day, as soon as the late deadline (workStart + grace) passes,
 * email a summary of employees who still haven't checked in. Each of them
 * also gets a reminder if "emailEmployee" is on.
 */
async function checkNoShows() {
  const s = getSettings();
  if (!s.notifyNoShow) return;

  const now = localParts(new Date(), s.timezone);
  if (!s.workDays.includes(now.weekday)) return;

  const deadline = toMinutes(s.workStart) + s.graceMinutes;
  if (now.minutes < deadline || now.minutes >= toMinutes(s.workEnd)) return;

  const claimed = db
    .prepare("INSERT OR IGNORE INTO notification_log (date, kind) VALUES (?, 'no_show')")
    .run(now.date);
  if (claimed.changes === 0) return; // already sent today

  const missing = db
    .prepare(
      `SELECT u.name, u.email FROM users u
       WHERE u.active = 1 AND u.role = 'employee'
         AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.user_id = u.id AND a.date = ?)
       ORDER BY u.name`,
    )
    .all(now.date);
  if (missing.length === 0) return;

  const list = missing.map((m) => `  - ${m.name} <${m.email}>`).join('\n');
  await sendMail({
    to: alertRecipients(s),
    subject: `${missing.length} employee(s) not checked in - ${now.date}`,
    text:
      `The following employees had not checked in at ${s.officeName} by ` +
      `${s.workStart} (+${s.graceMinutes} min grace) on ${now.date}:\n\n${list}\n`,
  });

  if (s.emailEmployee) {
    for (const m of missing) {
      await sendMail({
        to: [m.email],
        subject: `You have not checked in today (${now.date})`,
        text:
          `Hi ${m.name},\n\nWork starts at ${s.workStart} and you have not checked in at ` +
          `${s.officeName} yet. Please check in as soon as you arrive.\n`,
      });
    }
  }
}

export function startScheduler() {
  const run = () => checkNoShows().catch((err) => console.error('[scheduler]', err));
  run();
  setInterval(run, 60 * 1000);
}
