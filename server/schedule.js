// "Is this person expected on this date, and when?" — the single source of truth used by
// check-in/out, the no-show alerts and every report, so they can never disagree.
//
// Inputs, loaded once per call into a context (no per-person queries):
//   work_terms  per-person contract history (latest effective_from <= date wins)
//   time_off    approved and pending requests overlapping the range
//   holidays    institution closures (one-off or yearly)
//   settings    institution default days and hours
import { db } from './db.js';
import { toMinutes, weekdayOf } from './time.js';

export const TIME_OFF_TYPES = {
  sick: 'Sick',
  personal: 'Personal',
  maternity: 'Maternity leave',
  paternity: 'Paternity leave',
  mission: 'On mission',
  adjusted: 'Adjusted hours',
};

const fmt = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const md = (ymd) => ymd.slice(5); // 'MM-DD'

function holidayMatches(h, date) {
  if (!h.yearly) return h.start_date <= date && date <= h.end_date;
  const d = md(date);
  const a = md(h.start_date);
  const b = md(h.end_date);
  return a <= b ? a <= d && d <= b : d >= a || d <= b; // range may cross New Year
}

function weekdayAllowed(t, wd) {
  if (!t.weekdays) return true;
  try {
    return JSON.parse(t.weekdays).includes(wd);
  } catch {
    return true;
  }
}

/**
 * Loads everything needed to plan [from, to] for one institution.
 * `userIds` (optional) narrows the contract and time-off queries; pass it for single-person lookups.
 */
export function loadPlanContext(instId, settings, from, to, userIds = null) {
  const one = userIds && userIds.length === 1 ? userIds[0] : null;
  const terms = one
    ? db.prepare('SELECT * FROM work_terms WHERE user_id = ? AND institution_id = ? ORDER BY effective_from').all(one, instId)
    : db.prepare('SELECT * FROM work_terms WHERE institution_id = ? ORDER BY user_id, effective_from').all(instId);
  const timeOff = one
    ? db
        .prepare(
          `SELECT * FROM time_off WHERE user_id = ? AND institution_id = ? AND status IN ('approved', 'pending')
           AND start_date <= ? AND end_date >= ? ORDER BY id`,
        )
        .all(one, instId, to, from)
    : db
        .prepare(
          `SELECT * FROM time_off WHERE institution_id = ? AND status IN ('approved', 'pending')
           AND start_date <= ? AND end_date >= ? ORDER BY id`,
        )
        .all(instId, to, from);
  const holidays = db
    .prepare('SELECT * FROM holidays WHERE institution_id = ? AND (yearly = 1 OR (start_date <= ? AND end_date >= ?))')
    .all(instId, to, from);

  const termsByUser = new Map();
  for (const t of terms) {
    if (!termsByUser.has(t.user_id)) termsByUser.set(t.user_id, []);
    termsByUser.get(t.user_id).push({ ...t, scheduleObj: t.schedule ? JSON.parse(t.schedule) : null });
  }
  const offByUser = new Map();
  for (const t of timeOff) {
    if (!offByUser.has(t.user_id)) offByUser.set(t.user_id, []);
    offByUser.get(t.user_id).push(t);
  }
  return makeContext(settings, termsByUser, offByUser, holidays);
}

function makeContext(s, termsByUser, offByUser, holidays) {
  const termsFor = (userId, date) => {
    const list = termsByUser.get(userId);
    if (!list) return null;
    let found = null;
    for (const t of list) if (t.effective_from <= date) found = t;
    return found;
  };
  const holidayOn = (date) => holidays.find((h) => holidayMatches(h, date)) || null;

  /** The person's normal pattern for that date, ignoring holidays and time off. */
  function basePattern(userId, date) {
    const wd = weekdayOf(date);
    const terms = termsFor(userId, date);
    const partTime = terms?.employment_type === 'part_time';
    const sched = terms?.scheduleObj || null;
    if (partTime && !sched) {
      return { terms, partTime, flexible: true, scheduled: s.workDays.includes(wd), start: null, end: null, customDays: false };
    }
    if (sched) {
      const times = sched[wd];
      const scheduled = Object.prototype.hasOwnProperty.call(sched, String(wd));
      const [start, end] = times || [s.workStart, s.workEnd];
      return { terms, partTime, flexible: false, scheduled, start, end, customDays: true };
    }
    return { terms, partTime: false, flexible: false, scheduled: s.workDays.includes(wd), start: s.workStart, end: s.workEnd, customDays: false };
  }

  /**
   * The plan for one person on one date:
   *   expected      true when they should be at work (late/early/absent apply)
   *   start, end    the window late/early are judged against ('HH:MM'), after half days / adjustments
   *   reason        scheduled | flexible | holiday | non_working_day | day_off | not_scheduled | time_off | mission | pending
   *   label         short human text for the UI ("08:00–17:00", "Day off", "Sick", "Holiday: Christmas Day")
   *   baseMinutes   scheduled minutes of a normal day (fixed schedules); null when flexible
   *   offFraction   share of the day covered by leave/holiday (0, 0.5 or 1) — lowers a contract target
   *   creditFraction share of the day credited as worked without check-in (missions)
   */
  function dayPlan(userId, date) {
    const p = basePattern(userId, date);
    const baseMinutes = p.flexible || !p.scheduled ? (p.flexible ? null : 0) : Math.max(0, toMinutes(p.end) - toMinutes(p.start));
    const common = {
      date,
      partTime: p.partTime,
      flexible: p.flexible,
      customDays: p.customDays,
      workingDay: p.scheduled, // a day they'd normally work (flexible: an institution work day)
      baseMinutes,
      offFraction: 0,
      creditFraction: 0,
      timeOff: null,
      holiday: null,
    };

    const holiday = holidayOn(date);
    if (holiday) {
      return { ...common, expected: false, reason: 'holiday', label: `Holiday: ${holiday.name}`, holiday, offFraction: p.scheduled ? 1 : 0 };
    }
    if (!p.scheduled && !p.flexible) {
      const reason = p.partTime ? 'not_scheduled' : p.customDays ? 'day_off' : 'non_working_day';
      const label = p.partTime ? 'Not scheduled' : p.customDays ? 'Day off' : 'Not a work day';
      return { ...common, expected: false, reason, label };
    }

    const wd = weekdayOf(date);
    const offs = (offByUser.get(userId) || []).filter((t) => t.start_date <= date && date <= t.end_date && weekdayAllowed(t, wd));
    const approved = offs.filter((t) => t.status === 'approved');
    const pending = offs.filter((t) => t.status === 'pending');

    const fullDay = approved.find((t) => t.type !== 'adjusted' && t.part === 'full');
    if (fullDay) {
      if (fullDay.type === 'mission') {
        return { ...common, expected: false, reason: 'mission', label: TIME_OFF_TYPES.mission, timeOff: fullDay, creditFraction: 1 };
      }
      return { ...common, expected: false, reason: 'time_off', label: TIME_OFF_TYPES[fullDay.type], timeOff: fullDay, offFraction: 1 };
    }
    const pendingFull = pending.find((t) => t.type !== 'adjusted' && t.part === 'full');
    if (pendingFull) {
      return { ...common, expected: false, reason: 'pending', label: `${TIME_OFF_TYPES[pendingFull.type]} (requested)`, timeOff: pendingFull };
    }

    const half = approved.find((t) => t.type !== 'adjusted' && t.part !== 'full') || pending.find((t) => t.type !== 'adjusted' && t.part !== 'full');
    if (p.flexible) {
      const plan = { ...common, expected: false, reason: 'flexible', label: 'Flexible' };
      if (half && half.status === 'approved') {
        plan.timeOff = half;
        plan[half.type === 'mission' ? 'creditFraction' : 'offFraction'] = 0.5;
        plan.label = `Flexible · ${TIME_OFF_TYPES[half.type]} (${half.part === 'am' ? 'morning' : 'afternoon'})`;
      }
      return plan;
    }

    let start = toMinutes(p.start);
    let end = toMinutes(p.end);
    let label = `${p.start}–${p.end}`;
    const plan = { ...common, expected: true, reason: 'scheduled' };

    if (half) {
      let split = toMinutes(s.halfDaySplit || '13:00');
      if (!(split > start && split < end)) split = Math.round((start + end) / 2);
      if (half.part === 'am') start = split;
      else end = split;
      plan.timeOff = half;
      if (half.status === 'approved') plan[half.type === 'mission' ? 'creditFraction' : 'offFraction'] = 0.5;
      label = `${fmt(start)}–${fmt(end)} · ${TIME_OFF_TYPES[half.type]} ${half.part === 'am' ? 'morning' : 'afternoon'}${half.status === 'pending' ? ' (requested)' : ''}`;
      plan.half = half.part;
    }

    const adjusted = approved.find((t) => t.type === 'adjusted');
    if (adjusted) {
      if (adjusted.arrive_by && toMinutes(adjusted.arrive_by) > start) start = toMinutes(adjusted.arrive_by);
      if (adjusted.leave_from && toMinutes(adjusted.leave_from) < end) end = toMinutes(adjusted.leave_from);
      plan.adjusted = adjusted;
      label += ` · adjusted${adjusted.arrive_by ? `, arrive by ${adjusted.arrive_by}` : ''}${adjusted.leave_from ? `, leave from ${adjusted.leave_from}` : ''}`;
    }

    return { ...plan, start: fmt(start), end: fmt(end), label };
  }

  return { dayPlan, termsFor, holidayOn, basePattern };
}

/** Counts the working days a time-off request covers for one person (holidays and days off excluded). */
export function countWorkingDays(ctx, userId, from, to, part, weekdays) {
  let n = 0;
  const d = new Date(`${from}T00:00:00Z`);
  for (;;) {
    const date = d.toISOString().slice(0, 10);
    if (date > to) break;
    const wd = d.getUTCDay();
    const base = ctx.basePattern(userId, date);
    if (base.scheduled && !ctx.holidayOn(date) && (!weekdays || weekdays.includes(wd))) n += part === 'full' ? 1 : 0.5;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return n;
}

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Full-time", "Full-time · Fri off", "Part-time · 20 hr/wk" — for tables and badges. */
export function contractSummary(terms, settings) {
  if (!terms) return 'Full-time';
  const sched = terms.schedule ? JSON.parse(terms.schedule) : null;
  if (terms.employment_type === 'full_time') {
    if (!sched) return 'Full-time';
    const days = Object.keys(sched).map(Number);
    const off = settings.workDays.filter((d) => !days.includes(d)).map((d) => DAY[d]);
    return off.length ? `Full-time · ${off.join(', ')} off` : 'Full-time · custom days';
  }
  const hrs = Math.round(((terms.contract_minutes || 0) / 60) * 10) / 10;
  return `Part-time · ${hrs} hr/${terms.contract_period === 'month' ? 'mo' : 'wk'}`;
}
