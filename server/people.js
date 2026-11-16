// People helpers shared by routes, the scheduler and reports: managers, alert recipients,
// team scope and contract summaries.
import { db } from './db.js';
import { alertRecipients } from './mailer.js';

/** The person's active manager (role manager or admin, same institution), or null. */
export function managerOf(user) {
  if (!user?.manager_id) return null;
  return (
    db
      .prepare("SELECT * FROM users WHERE id = ? AND institution_id = ? AND active = 1 AND role IN ('manager', 'admin')")
      .get(user.manager_id, user.institution_id) || null
  );
}

/** HR alert emails + the person's manager + (optionally) the person. */
export function alertTargets(settings, user) {
  const to = alertRecipients(settings);
  const m = managerOf(user);
  if (m) to.push(m.email);
  if (settings.emailEmployee) to.push(user.email);
  return to;
}

/**
 * Which people the signed-in staff member may act on:
 * admins (and support sessions) -> null meaning "everyone in the institution";
 * managers -> the ids of their direct reports.
 */
export function teamScope(req) {
  if (req.user.role === 'admin') return null;
  return db
    .prepare('SELECT id FROM users WHERE manager_id = ? AND institution_id = ?')
    .all(req.user.id, req.inst.id)
    .map((r) => r.id);
}

/** SQL fragment + params restricting a users alias to the caller's scope. */
export function scopeSql(req, alias = 'u') {
  if (req.user.role === 'admin') return { sql: `${alias}.institution_id = ?`, params: [req.inst.id] };
  return { sql: `${alias}.institution_id = ? AND ${alias}.manager_id = ?`, params: [req.inst.id, req.user.id] };
}

/** A user in the caller's scope, or null. */
export function userInScope(req, userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND institution_id = ?').get(Number(userId), req.inst.id);
  if (!user) return null;
  if (req.user.role === 'admin') return user;
  return user.manager_id === req.user.id ? user : null;
}

/** Latest work terms per user for an institution as a Map(userId -> terms). One query. */
export function latestTermsMap(instId, onDate) {
  const rows = db
    .prepare(
      `SELECT t.* FROM work_terms t
       JOIN (SELECT user_id, MAX(effective_from) AS ef FROM work_terms
             WHERE institution_id = ? AND effective_from <= ? GROUP BY user_id) x
         ON x.user_id = t.user_id AND x.ef = t.effective_from`,
    )
    .all(instId, onDate);
  return new Map(rows.map((r) => [r.user_id, r]));
}

export { contractSummary } from './schedule.js';
