import { db, getSettings } from './db.js';
import { localParts, toMinutes, addDays } from './time.js';
import { sendMail, alertRecipients } from './mailer.js';
import { runReportJob } from './reportJobs.js';
import { loadPlanContext } from './schedule.js';
import { managerOf } from './people.js';

/** Returns true the first time it is called for (institution, date, kind). */
function claimOnce(instId, date, kind) {
  const r = db
    .prepare('INSERT OR IGNORE INTO notification_log (institution_id, date, kind) VALUES (?, ?, ?)')
    .run(instId, date, kind);
  return r.changes > 0;
}

/**
 * No-show alerts, per person: once someone's own expected start + grace has passed and they
 * haven't checked in, they're included in one email for that start time. People who aren't
 * expected today (day off, holiday, time off, pending request, flexible hours) are never included.
 * HR gets everyone; each manager gets only their team; the employee optionally gets a reminder.
 */
async function checkNoShows(inst, s, now) {
  if (!s.notifyNoShow) return;
  const people = db
    .prepare("SELECT * FROM users WHERE institution_id = ? AND active = 1 AND role IN ('employee', 'manager')")
    .all(inst.id);
  if (people.length === 0) return;
  const ctx = loadPlanContext(inst.id, s, now.date, now.date);
  const checkedIn = new Set(
    db
      .prepare('SELECT a.user_id FROM attendance a JOIN users u ON u.id = a.user_id WHERE u.institution_id = ? AND a.date = ?')
      .all(inst.id, now.date)
      .map((r) => r.user_id),
  );

  const byStart = new Map();
  for (const u of people) {
    if (checkedIn.has(u.id)) continue;
    const p = ctx.dayPlan(u.id, now.date);
    if (!p.expected) continue;
    const deadline = toMinutes(p.start) + s.graceMinutes;
    if (now.minutes < deadline || now.minutes >= toMinutes(p.end)) continue;
    if (!byStart.has(p.start)) byStart.set(p.start, []);
    byStart.get(p.start).push(u);
  }

  for (const [start, missing] of byStart) {
    if (!claimOnce(inst.id, now.date, `no_show:${start}`)) continue;
    const line = (m) => `  - ${m.name} <${m.email}>`;
    const intro = `had not checked in at ${s.officeName} by ${start} (+${s.graceMinutes} min grace) on ${now.date}:`;

    await sendMail({
      to: alertRecipients(s),
      brand: inst,
      subject: `${missing.length} employee(s) not checked in (${start} start) - ${now.date}`,
      text: `The following employees ${intro}\n\n${missing.map(line).join('\n')}\n`,
    });

    const byManager = new Map();
    for (const m of missing) {
      const mgr = managerOf(m);
      if (!mgr) continue;
      if (!byManager.has(mgr.id)) byManager.set(mgr.id, { mgr, team: [] });
      byManager.get(mgr.id).team.push(m);
    }
    for (const { mgr, team } of byManager.values()) {
      await sendMail({
        to: [mgr.email],
        brand: inst,
        subject: `${team.length} of your team not checked in - ${now.date}`,
        text: `Hi ${mgr.name},\n\nThese people on your team ${intro}\n\n${team.map(line).join('\n')}\n`,
      });
    }

    if (s.emailEmployee) {
      for (const m of missing) {
        await sendMail({
          to: [m.email],
          brand: inst,
          subject: `You have not checked in today (${now.date})`,
          text:
            `Hi ${m.name},\n\nYou were expected at ${start} and have not checked in at ` +
            `${s.officeName} yet. Please check in as soon as you arrive, or request time off if you're away.\n`,
        });
      }
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

/** One pass over every active institution. Exported so tests can run it on demand. */
export async function tick(at = new Date()) {
  const institutions = db.prepare("SELECT * FROM institutions WHERE status = 'active'").all();
  for (const inst of institutions) {
    try {
      const s = getSettings(inst.id);
      const now = localParts(at, s.timezone);
      await checkNoShows(inst, s, now);
      await weeklyReport(inst, s, now);
    } catch (err) {
      console.error(`[scheduler] ${inst.code}:`, err);
    }
  }
  // Housekeeping: expired codes and links.
  const nowIso = new Date().toISOString();
  db.prepare('DELETE FROM login_challenges WHERE expires_at < ?').run(nowIso);
  db.prepare('DELETE FROM tokens WHERE expires_at < ?').run(nowIso);
}

export function startScheduler() {
  const run = () => tick().catch((err) => console.error('[scheduler]', err));
  run();
  setInterval(run, 60 * 1000);
}
