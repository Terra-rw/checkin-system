// Contracts, time off, managers and corrections, end to end:
// - managers only see and act on their own team
// - time-off requests go to the manager, are approved/declined, and change who is expected
// - half days and adjusted hours move the late/early window; nobody is late when not expected
// - corrections keep an audit trail; check-out after midnight closes yesterday's record
// - the "Hours vs contract" report for part-timers
import { DatabaseSync } from 'node:sqlite';
import { startServer, loginWithCode, reporter, kigaliDate } from './helpers.mjs';

const HERE = { lat: -1.9442, lng: 30.062, accuracy: 10 };

export async function run() {
  const t = reporter('Contracts, time off & managers');
  const srv = await startServer();
  const { call } = srv;
  let db;
  try {
    // --- institution, HR admin, settings (work all day, every day, no grace)
    let r = await call('POST', '/auth/login', { email: 'owner@test.local', password: 'ownerpass1' });
    r = await call('POST', '/auth/verify', { challenge: r.data.challenge, code: srv.lastCode() });
    const owner = r.data.token;
    await call('POST', '/platform/institutions', { name: 'Acme', code: 'acme', timezone: 'Africa/Kigali', adminName: 'Acme HR', adminEmail: 'hr@acme.test' }, owner);
    await call('POST', '/auth/reset', { token: srv.lastLink(), password: 'hr-pass-123' });
    const hr = (await loginWithCode(srv, 'acme', 'hr@acme.test', 'hr-pass-123')).token;
    await call('PUT', '/admin/settings', { officeLat: -1.944, officeLng: 30.0619, workStart: '00:00', workEnd: '23:59', graceMinutes: 0, workDays: [0, 1, 2, 3, 4, 5, 6], alertEmails: 'alerts@acme.test' }, hr);

    // --- people: a manager with one report (Mia), and others outside that team
    r = await call('POST', '/admin/users', { name: 'Maya Manager', email: 'maya@acme.test', password: 'maya-pass-1', role: 'manager' }, hr);
    t.check('manager created', r.status === 201 && r.data.user.role === 'manager', JSON.stringify(r.data));
    const mayaId = r.data.user.id;
    r = await call('POST', '/admin/users', { name: 'Mia Report', email: 'mia@acme.test', password: 'mia-pass-12', managerId: mayaId }, hr);
    t.check('employee created reporting to the manager', r.status === 201 && r.data.user.managerId === mayaId, JSON.stringify(r.data));
    const miaId = r.data.user.id;
    const ids = {};
    for (const [key, name] of [['omar', 'Omar Other'], ['pat', 'Pat Parttime'], ['lee', 'Lee Late'], ['kim', 'Kim Forgot'], ['dee', 'Dee Dayoff']]) {
      ids[key] = (await call('POST', '/admin/users', { name, email: `${key}@acme.test`, password: `${key}-pass-123` }, hr)).data.user.id;
    }
    r = await call('POST', '/admin/users', { name: 'Bad Boss', email: 'bad@acme.test', password: 'bad-pass-123', managerId: ids.omar }, hr);
    t.check('only managers/admins can be someone’s manager', r.status === 400, JSON.stringify(r.data));

    const maya = (await loginWithCode(srv, 'acme', 'maya@acme.test', 'maya-pass-1')).token;
    const mia = (await loginWithCode(srv, 'acme', 'mia@acme.test', 'mia-pass-12')).token;
    const omar = (await loginWithCode(srv, 'acme', 'omar@acme.test', 'omar-pass-123')).token;
    const today = kigaliDate();

    // --- manager scope
    r = await call('GET', '/team/people', null, maya);
    t.check('manager sees only their team', r.status === 200 && r.data.length === 1 && r.data[0].id === miaId, JSON.stringify(r.data.map((p) => p.name)));
    r = await call('GET', '/team/people', null, hr);
    t.check('HR sees everyone', r.data.length >= 7, String(r.data.length));
    r = await call('GET', `/team/attendance?from=${today}`, null, maya);
    t.check('manager attendance lists only the team', r.status === 200 && r.data.rows.every((x) => x.user_id === miaId) && r.data.rows.length === 1, JSON.stringify(r.data.rows?.map((x) => x.name)));
    t.check('manager cannot use admin routes', (await call('GET', '/admin/users', null, maya)).status === 403);
    t.check('employee cannot use team routes', (await call('GET', '/team/people', null, mia)).status === 403);
    r = await call('GET', '/me', null, mia);
    t.check('/me shows manager and today’s plan', r.data.manager?.name === 'Maya Manager' && r.data.plan?.expected === true, JSON.stringify({ m: r.data.manager, p: r.data.plan }));

    // --- time off request → manager → decision
    let before = srv.log.length;
    r = await call('POST', '/time-off', { type: 'sick', startDate: kigaliDate(10), reason: 'Surgery' }, mia);
    t.check('employee requests time off', r.status === 201 && r.data.request.status === 'pending' && /Maya Manager/.test(r.data.message), JSON.stringify(r.data));
    const sickId = r.data.request.id;
    t.check('request emailed to the manager', /To:[^\n]*maya@acme\.test/.test(srv.log.slice(before)) && /Time off request: Mia Report/.test(srv.log.slice(before)));
    r = await call('POST', '/time-off', { type: 'personal', startDate: kigaliDate(10) }, mia);
    t.check('overlapping request rejected', r.status === 409, JSON.stringify(r.data));
    r = await call('GET', `/team/attendance?from=${kigaliDate(10)}`, null, maya);
    let row = r.data.rows.find((x) => x.user_id === miaId);
    t.check('pending request: not expected that day', row?.status === 'not_expected' && row.plan.reason === 'pending', JSON.stringify(row?.plan));

    before = srv.log.length;
    r = await call('POST', '/time-off', { type: 'personal', startDate: today }, omar);
    t.check('no manager: request goes to HR alert emails', r.status === 201 && /HR/.test(r.data.message) && /To:[^\n]*alerts@acme\.test/.test(srv.log.slice(before)), JSON.stringify(r.data));
    const omarReq = r.data.request.id;
    r = await call('POST', `/team/time-off/${omarReq}/decide`, { decision: 'approve' }, maya);
    t.check('manager cannot decide for someone outside the team', r.status === 404, JSON.stringify(r.data));
    r = await call('POST', `/team/time-off/${omarReq}/decide`, { decision: 'decline' }, hr);
    t.check('declining needs a reason', r.status === 400, JSON.stringify(r.data));
    r = await call('POST', `/team/time-off/${omarReq}/decide`, { decision: 'decline', note: 'We are short-staffed today' }, hr);
    t.check('HR declines with a reason', r.status === 200, JSON.stringify(r.data));

    r = await call('GET', '/team/time-off?status=pending', null, maya);
    t.check('manager inbox shows the pending request', r.data.length === 1 && r.data[0].id === sickId && r.data[0].workingDays === 1, JSON.stringify(r.data));
    before = srv.log.length;
    r = await call('POST', `/team/time-off/${sickId}/decide`, { decision: 'approve' }, maya);
    t.check('manager approves', r.status === 200 && /To:[^\n]*mia@acme\.test/.test(srv.log.slice(before)), JSON.stringify(r.data));
    r = await call('POST', `/team/time-off/${sickId}/decide`, { decision: 'approve' }, maya);
    t.check('cannot decide twice', r.status === 409);
    r = await call('GET', '/time-off', null, mia);
    t.check('employee sees the status and approver', r.data.approver === 'Maya Manager' && r.data.requests[0].status === 'approved' && r.data.requests[0].decidedBy === 'Maya Manager', JSON.stringify(r.data));
    t.check('employee cannot cancel approved time off', (await call('POST', `/time-off/${sickId}/cancel`, null, mia)).status === 409);
    r = await call('GET', `/team/attendance?from=${kigaliDate(10)}`, null, maya);
    row = r.data.rows.find((x) => x.user_id === miaId);
    t.check('approved sick day shows in attendance', row?.status === 'not_expected' && row.plan.label === 'Sick', JSON.stringify(row?.plan));

    // --- half day: afternoon off today ends Mia's day at the split time
    r = await call('POST', '/team/time-off', { userId: miaId, type: 'personal', part: 'pm', startDate: today }, maya);
    t.check('manager records a half day (auto-approved)', r.status === 201 && r.data.request.status === 'approved' && r.data.request.workingDays === 0.5, JSON.stringify(r.data));
    r = await call('GET', '/me', null, mia);
    t.check('half day changes the end time', r.data.plan.end === '13:00' && /afternoon/.test(r.data.plan.label), JSON.stringify(r.data.plan));
    r = await call('POST', '/team/time-off', { userId: ids.omar, type: 'sick', startDate: today }, maya);
    t.check('manager cannot record time off outside the team', r.status === 404);

    // --- adjusted hours: Omar may arrive by 23:59, so checking in now is not late
    r = await call('POST', '/team/time-off', { userId: ids.omar, type: 'adjusted', startDate: today, arriveBy: '23:59' }, hr);
    t.check('HR records adjusted hours', r.status === 201, JSON.stringify(r.data));
    before = srv.log.length;
    r = await call('POST', '/attendance/check-in', HERE, omar);
    t.check('adjusted hours: check-in not late, no alert', r.status === 200 && r.data.record.late === 0 && !/Late check-in: Omar/.test(srv.log.slice(before)), JSON.stringify(r.data));
    before = srv.log.length;
    const mia1 = await call('POST', '/attendance/check-in', HERE, mia);
    const mailed = srv.log.slice(before);
    t.check('without an adjustment, the same check-in is late', mia1.data.record?.late === 1, JSON.stringify(mia1.data));
    t.check('late alert goes to HR and the manager', /Late check-in: Mia Report/.test(mailed) && /To:[^\n]*alerts@acme\.test[^\n]*maya@acme\.test/.test(mailed), mailed.slice(0, 300));
    // --- full-timer with a negotiated day off today: not expected, never late
    const wd = new Date(`${today}T12:00:00Z`).getUTCDay();
    r = await call('PUT', `/admin/users/${ids.dee}/terms`, { effectiveFrom: '2026-01-01', employmentType: 'full_time', mode: 'custom', days: [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== wd) }, hr);
    t.check('custom working days saved', r.status === 200 && /off/.test(r.data.contract), JSON.stringify(r.data));
    r = await call('GET', `/team/attendance?from=${today}`, null, hr);
    row = r.data.rows.find((x) => x.user_id === ids.dee);
    t.check('day off: not expected, not absent', row?.status === 'not_expected' && row.plan.reason === 'day_off', JSON.stringify(row));
    const dee = (await loginWithCode(srv, 'acme', 'dee@acme.test', 'dee-pass-123')).token;
    r = await call('POST', '/attendance/check-in', HERE, dee);
    t.check('working on a day off is allowed and not late', r.status === 200 && r.data.record.late === 0, JSON.stringify(r.data));

    // --- holiday today: nobody without a record is absent
    r = await call('POST', '/admin/holidays', { name: 'Test Holiday', startDate: today }, hr);
    const holId = r.data.id;
    r = await call('GET', `/team/attendance?from=${today}`, null, hr);
    row = r.data.rows.find((x) => x.user_id === ids.kim);
    t.check('holiday: not expected', row?.status === 'not_expected' && row.plan.reason === 'holiday', JSON.stringify(row?.plan));
    t.check('holiday removed', (await call('DELETE', `/admin/holidays/${holId}`, null, hr)).status === 200);

    // --- direct DB setup for past records (the server writes these through check-in in real life)
    db = new DatabaseSync(srv.dbPath);
    db.exec('PRAGMA busy_timeout = 5000');
    const insert = db.prepare('INSERT INTO attendance (user_id, date, check_in_at, check_out_at) VALUES (?, ?, ?, ?)');
    const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();
    const yesterday = kigaliDate(-1);

    // --- check-out after midnight closes yesterday's open record (under 16 h)
    insert.run(ids.lee, yesterday, ago(2), null);
    const lee = (await loginWithCode(srv, 'acme', 'lee@acme.test', 'lee-pass-123')).token;
    r = await call('POST', '/attendance/check-out', HERE, lee);
    t.check('check-out after midnight closes yesterday', r.status === 200 && r.data.record.date === yesterday && r.data.record.early === 0, JSON.stringify(r.data));

    // --- a forgotten check-out (over 16 h) needs a manager fix, which is audited
    insert.run(ids.kim, yesterday, ago(20), null);
    const kim = (await loginWithCode(srv, 'acme', 'kim@acme.test', 'kim-pass-123')).token;
    r = await call('POST', '/attendance/check-out', HERE, kim);
    t.check('forgotten check-out is not closed with a bogus duration', r.status === 409 && /didn't check out yesterday/.test(r.data.error), JSON.stringify(r.data));
    const kimRec = db.prepare('SELECT id FROM attendance WHERE user_id = ? AND date = ?').get(ids.kim, yesterday).id;
    r = await call('PATCH', `/team/attendance/${kimRec}`, { checkIn: '08:00', checkOut: '17:00' }, hr);
    t.check('a fix needs a reason', r.status === 400, JSON.stringify(r.data));
    r = await call('PATCH', `/team/attendance/${kimRec}`, { checkIn: '08:00', checkOut: '17:00', reason: 'Forgot to check out' }, maya);
    t.check('manager cannot fix someone outside the team', r.status === 404);
    r = await call('PATCH', `/team/attendance/${kimRec}`, { checkIn: '08:00', checkOut: '17:00', reason: 'Forgot to check out' }, hr);
    t.check('HR fixes the record', r.status === 200 && r.data.record.source === 'edited', JSON.stringify(r.data));
    r = await call('GET', `/team/attendance/${kimRec}/history`, null, hr);
    t.check('audit trail keeps both changes', r.data.changes?.length === 2 && r.data.changes.every((c) => c.reason === 'Forgot to check out' && c.by === 'Acme HR'), JSON.stringify(r.data));
    r = await call('GET', `/team/attendance?from=${yesterday}`, null, hr);
    row = r.data.rows.find((x) => x.user_id === ids.kim);
    t.check('fixed day shows 9 hr worked, marked edited', row?.workedMinutes === 540 && row.edited, JSON.stringify(row));

    // --- Hours vs contract: Pat is part-time, 10 hr/week, flexible
    r = await call('PUT', `/admin/users/${ids.pat}/terms`, { effectiveFrom: '2026-01-01', employmentType: 'part_time', contractHours: 10, contractPeriod: 'week', mode: 'flexible' }, hr);
    t.check('part-time contract saved', r.status === 200 && r.data.contract === 'Part-time · 10 hr/wk', JSON.stringify(r.data));
    r = await call('GET', `/team/attendance?from=${today}`, null, hr);
    row = r.data.rows.find((x) => x.user_id === ids.pat);
    t.check('flexible part-timer is never absent', row?.status === 'not_expected' && row.plan.reason === 'flexible', JSON.stringify(row?.plan));
    for (const d of [-3, -2]) {
      const day = kigaliDate(d);
      insert.run(ids.pat, day, `${day}T07:00:00.000Z`, `${day}T10:00:00.000Z`); // 3 hr each
    }
    insert.run(ids.pat, kigaliDate(-4), `${kigaliDate(-4)}T07:00:00.000Z`, null); // missing check-out
    const weekAgo = kigaliDate(-6);
    r = await call('GET', `/team/reports?type=hours&from=${weekAgo}&to=${today}`, null, hr);
    const pat = r.data.rows?.find((x) => x.name === 'Pat Parttime');
    t.check('hours report lists only part-timers', r.status === 200 && r.data.total === 1 && pat, JSON.stringify(r.data).slice(0, 300));
    t.check('hours report: 10 hr target, 6 hr worked, 4 hr under', pat?.targetMin === '10 hr' && pat.workedMin === '6 hr' && /4 hr under/.test(pat.difference), JSON.stringify(pat));
    t.check('hours report: decimal hours and missing check-outs', pat?.workedHours === '6' && pat.differenceHours === '-4' && pat.missing === '1', JSON.stringify(pat));
    t.check('hours report warns about missing check-outs', r.data.warnings?.length === 1 && /1 missing check-out/.test(r.data.warnings[0]), JSON.stringify(r.data.warnings));
    const xlsx = await call('GET', `/team/reports?type=hours&from=${weekAgo}&to=${today}&format=xlsx`, null, hr, true);
    t.check('hours report exports', xlsx.status === 200 && (await xlsx.arrayBuffer()).byteLength > 1000);

    // --- summary report: scoped for managers, leave shown, not-expected days never absent
    r = await call('GET', `/team/reports?type=summary&from=${weekAgo}&to=${kigaliDate(10)}`, null, maya);
    t.check('manager reports only cover the team', r.status === 200 && r.data.total === 1 && r.data.rows[0].name === 'Mia Report', JSON.stringify(r.data.rows));
    r = await call('GET', `/team/reports?type=summary&from=${weekAgo}&to=${today}`, null, hr);
    const patSum = r.data.rows.find((x) => x.name === 'Pat Parttime');
    const deeSum = r.data.rows.find((x) => x.name === 'Dee Dayoff');
    t.check('flexible part-timer has no absences', patSum?.absent === '0', JSON.stringify(patSum));
    t.check('day off is not counted absent', deeSum?.absent === '0' && deeSum.present === '1', JSON.stringify(deeSum));
    r = await call('GET', `/team/reports?type=daily&from=${today}&to=${today}`, null, hr);
    const miaToday = r.data.rows.find((x) => x.name === 'Mia Report');
    t.check('daily log shows the day', !!miaToday, JSON.stringify(r.data.rows));

    // --- demoting the manager logs them out and frees their team
    r = await call('PATCH', `/admin/users/${mayaId}`, { role: 'employee' }, hr);
    t.check('manager demoted', r.status === 200 && r.data.role === 'employee', JSON.stringify(r.data));
    t.check('old manager session ends', (await call('GET', '/team/people', null, maya)).status === 401);
    r = await call('GET', '/admin/users', null, hr);
    t.check('their team no longer reports to them', r.data.find((u) => u.id === miaId)?.managerId === null, JSON.stringify(r.data.find((u) => u.id === miaId)));
    r = await call('PATCH', `/admin/users/${ids.omar}`, { name: 'Omar Renamed' }, hr);
    t.check('editing a name keeps the session', r.status === 200 && (await call('GET', '/me', null, omar)).status === 200);
  } catch (e) {
    t.fail(e);
  } finally {
    db?.close();
    await srv.stop();
  }
  return t.done(srv);
}
