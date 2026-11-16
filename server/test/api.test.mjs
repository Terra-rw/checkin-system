// End-to-end API flow: platform owner, invites, email codes, check-in, reports, password reset,
// lockout, branding, support access, suspension and institution search.
import { startServer, loginWithCode, reporter, makePng, kigaliDate } from './helpers.mjs';

export async function run() {
  const t = reporter('API flow');
  const srv = await startServer();
  const { call } = srv;
  try {
    // --- platform owner login with email code
    let r = await call('POST', '/auth/login', { email: 'owner@test.local', password: 'ownerpass1' });
    t.check('owner login asks for code', r.data.challenge && r.data.emailHint === 'o•••@test.local', JSON.stringify(r.data));
    r = await call('POST', '/auth/verify', { challenge: r.data.challenge, code: '000000' });
    t.check('wrong code rejected with tries left', r.status === 400 && /4 tries left/.test(r.data.error), JSON.stringify(r.data));
    r = await call('POST', '/auth/login', { email: 'owner@test.local', password: 'ownerpass1' });
    r = await call('POST', '/auth/verify', { challenge: r.data.challenge, code: srv.lastCode(), trust: true });
    t.check('right code gives session + device token', r.data.token && r.data.deviceToken, JSON.stringify(r.data));
    const owner = r.data.token;
    r = await call('POST', '/auth/login', { email: 'owner@test.local', password: 'ownerpass1', deviceToken: r.data.deviceToken });
    t.check('trusted device skips code', r.data.token && !r.data.challenge, JSON.stringify(r.data));

    // --- create institutions
    r = await call('POST', '/platform/institutions', { name: 'NGA', code: 'NGA', timezone: 'Africa/Kigali', adminName: 'Head of HR', adminEmail: 'hr@nga.test' }, owner);
    t.check('create institution', r.status === 201 && r.data.institution.code === 'nga', JSON.stringify(r.data));
    const inviteToken = srv.lastLink();
    t.check('invite link emailed', srv.log.includes('http://localhost:5173/nga/reset?token='));
    r = await call('POST', '/platform/institutions', { name: 'Other', code: 'nga', timezone: 'UTC', adminName: 'x', adminEmail: 'x@x.io' }, owner);
    t.check('duplicate code rejected', r.status === 409, JSON.stringify(r.data));
    await call('POST', '/platform/institutions', { name: 'Demo Clinic', code: 'demo-clinic', timezone: 'Africa/Nairobi', adminName: 'Clinic Admin', adminEmail: 'admin@clinic.test' }, owner);
    const clinicInvite = srv.lastLink();
    r = await call('GET', '/platform/institutions', null, owner);
    t.check('list shows 2 with invite pending', r.data.length === 2 && r.data.every((i) => i.invitePending), JSON.stringify(r.data));

    // --- invite acceptance
    r = await call('GET', `/auth/link?token=${inviteToken}`);
    t.check('invite link info', r.data.valid && r.data.kind === 'invite' && r.data.institution.code === 'nga', JSON.stringify(r.data));
    r = await call('POST', '/auth/reset', { token: inviteToken, password: 'short' });
    t.check('short password rejected', r.status === 400, JSON.stringify(r.data));
    r = await call('POST', '/auth/reset', { token: inviteToken, password: 'hr-password-1' });
    t.check('invite accepted', r.status === 200, JSON.stringify(r.data));
    r = await call('POST', '/auth/reset', { token: inviteToken, password: 'hr-password-2' });
    t.check('invite link single use', r.status === 400, JSON.stringify(r.data));
    await call('POST', '/auth/reset', { token: clinicInvite, password: 'clinic-pass-1' });

    // --- institution admin login
    const hr = (await loginWithCode(srv, 'nga', 'hr@nga.test', 'hr-password-1')).token;
    t.check('NGA admin logged in', !!hr);
    const clinic = (await loginWithCode(srv, 'demo-clinic', 'admin@clinic.test', 'clinic-pass-1')).token;
    r = await call('POST', '/auth/login', { institution: 'demo-clinic', email: 'hr@nga.test', password: 'hr-password-1' });
    t.check('NGA admin cannot log into other institution', r.status === 401, JSON.stringify(r.data));
    r = await call('POST', '/auth/login', { institution: 'nope', email: 'a@b.c', password: 'x' });
    t.check('unknown institution 404', r.status === 404, JSON.stringify(r.data));

    // --- settings & employees
    r = await call('PUT', '/admin/settings', { officeLat: -1.944, officeLng: 30.0619, radiusMeters: 100, workStart: '00:00', workEnd: '23:59', graceMinutes: 0, workDays: [0, 1, 2, 3, 4, 5, 6], alertEmails: 'boss@nga.test' }, hr);
    t.check('settings saved', r.status === 200 && r.data.settings.timezone === 'Africa/Kigali', JSON.stringify(r.data).slice(0, 200));
    r = await call('POST', '/admin/users', { name: 'Jane Uwase', email: 'jane@nga.test', password: 'jane-pass-1' }, hr);
    t.check('employee added with password', r.status === 201, JSON.stringify(r.data));
    r = await call('POST', '/admin/users', { name: 'Eric Mugisha', email: 'eric@nga.test' }, hr);
    t.check('employee invited without password', r.status === 201 && r.data.user.invitePending, JSON.stringify(r.data));
    r = await call('POST', '/admin/users', { name: 'Same Email', email: 'jane@nga.test', password: 'whatever1' }, clinic);
    t.check('same email allowed in another institution', r.status === 201, JSON.stringify(r.data));

    // --- employee: check in late, durations in hr/min
    const jane = await loginWithCode(srv, 'nga', 'jane@nga.test', 'jane-pass-1', true);
    t.check('jane trusted device token', !!jane.deviceToken);
    r = await call('POST', '/attendance/check-in', { lat: -1.9442, lng: 30.062, accuracy: 10 }, jane.token);
    t.check('late check-in uses hr/min', r.status === 200 && /\d+ (hr|min)/.test(r.data.message), JSON.stringify(r.data));
    r = await call('POST', '/attendance/check-in', { lat: -1.9442, lng: 30.062, accuracy: 10 }, jane.token);
    t.check('second check-in same day rejected', r.status === 409, JSON.stringify(r.data));
    r = await call('POST', '/attendance/check-out', { lat: -1.95, lng: 30.07, accuracy: 10 }, jane.token);
    t.check('check-out outside geofence rejected', r.status === 403, JSON.stringify(r.data));
    r = await call('POST', '/attendance/check-out', { lat: -1.9442, lng: 30.062, accuracy: 500 }, jane.token);
    t.check('imprecise GPS rejected', r.status === 400, JSON.stringify(r.data));
    r = await call('POST', '/attendance/check-out', { lat: -1.9442, lng: 30.062, accuracy: 10 }, jane.token);
    t.check('check-out ok', r.status === 200, JSON.stringify(r.data));

    // --- reports (built in the background worker)
    const today = kigaliDate();
    const weekAgo = kigaliDate(-6);
    r = await call('GET', `/team/reports?type=summary&from=${weekAgo}&to=${today}`, null, hr);
    t.check('summary report json', r.status === 200 && r.data.rows.some((x) => x.name === 'Jane Uwase'), JSON.stringify(r.data).slice(0, 300));
    r = await call('GET', `/team/reports?type=daily&from=${today}&to=${today}`, null, hr);
    t.check('daily report has absent rows', r.data.rows.some((x) => x.status === 'Absent'), JSON.stringify(r.data.rows));
    for (const fmt of ['csv', 'xlsx', 'pdf']) {
      const res = await call('GET', `/team/reports?type=daily&from=${weekAgo}&to=${today}&format=${fmt}`, null, hr, true);
      const buf = Buffer.from(await res.arrayBuffer());
      const magic = { csv: buf.toString('utf8', 0, 8).includes('Date'), xlsx: buf.toString('utf8', 0, 2) === 'PK', pdf: buf.toString('utf8', 0, 4) === '%PDF' }[fmt];
      t.check(`${fmt} download`, res.status === 200 && magic && /attachment/.test(res.headers.get('content-disposition')), res.status);
    }
    r = await call('GET', `/team/reports?type=summary&from=${today}&to=${weekAgo}`, null, hr);
    t.check('backwards date range rejected', r.status === 400, JSON.stringify(r.data));
    r = await call('POST', '/team/reports/email', { type: 'summary', from: weekAgo, to: today, format: 'pdf' }, hr);
    t.check('email report with attachment', r.status === 200 && /attachments: attendance-summary/.test(srv.log), JSON.stringify(r.data));

    // --- security page
    r = await call('GET', '/admin/security', null, hr);
    t.check('security lists device + events', r.data.devices.some((d) => d.email === 'jane@nga.test' && d.label === 'Chrome on Android') && r.data.events.length > 0, JSON.stringify(r.data).slice(0, 300));
    const janeDevice = r.data.devices.find((d) => d.email === 'jane@nga.test');
    r = await call('DELETE', `/admin/devices/${janeDevice.id}`, null, hr);
    t.check('admin removes device', r.status === 200, JSON.stringify(r.data));
    r = await call('POST', '/auth/login', { institution: 'nga', email: 'jane@nga.test', password: 'jane-pass-1', deviceToken: jane.deviceToken });
    t.check('removed device needs code again', !!r.data.challenge, JSON.stringify(r.data));

    // --- password reset flow
    r = await call('POST', '/auth/forgot', { institution: 'nga', email: 'nobody@nga.test' });
    t.check('forgot: unknown email same answer', r.status === 200 && r.data.ok);
    const before = srv.lastLink();
    await call('POST', '/auth/forgot', { institution: 'nga', email: 'jane@nga.test' });
    const resetToken = srv.lastLink();
    t.check('forgot: link emailed', resetToken && resetToken !== before && srv.log.includes('/nga/reset?token='));
    r = await call('POST', '/auth/reset', { token: resetToken, password: 'jane-pass-1' });
    t.check('reset: same password rejected', r.status === 400, JSON.stringify(r.data));
    r = await call('POST', '/auth/reset', { token: resetToken, password: 'jane-new-pass' });
    t.check('reset: password changed', r.status === 200, JSON.stringify(r.data));
    r = await call('GET', '/me', null, jane.token);
    t.check('reset logs out old sessions', r.status === 401, r.status);

    // --- lockout after 5 wrong codes
    r = await call('POST', '/auth/login', { institution: 'nga', email: 'jane@nga.test', password: 'jane-new-pass' });
    let last;
    for (let i = 0; i < 5; i++) last = await call('POST', '/auth/verify', { challenge: r.data.challenge, code: '999999' });
    t.check('5 wrong codes locks account', last.status === 423, JSON.stringify(last.data));
    r = await call('POST', '/auth/login', { institution: 'nga', email: 'jane@nga.test', password: 'jane-new-pass' });
    t.check('locked account cannot log in', r.status === 423, JSON.stringify(r.data));

    // --- branding
    const upload = async (kind, buf, type, token) => {
      const res = await fetch(`${srv.base}/api/admin/branding/${kind}`, { method: 'PUT', headers: { 'Content-Type': type, Authorization: 'Bearer ' + token }, body: buf });
      return { status: res.status, data: await res.json().catch(() => ({})) };
    };
    r = await upload('logo', makePng(64, 64), 'image/png', hr);
    t.check('logo upload', r.status === 200 && /^\/media\/inst\d+-logo-[0-9a-f]{16}\.png$/.test(r.data.logoUrl), JSON.stringify(r.data));
    const logoUrl = r.data.logoUrl;
    let media = await fetch(srv.base + logoUrl);
    t.check('logo served with nosniff + long cache', media.status === 200 && media.headers.get('content-type') === 'image/png' && media.headers.get('x-content-type-options') === 'nosniff' && /immutable/.test(media.headers.get('cache-control')), media.status);
    r = await call('GET', '/auth/institution/nga');
    t.check('public institution has logoUrl', r.data.logoUrl === logoUrl, JSON.stringify(r.data));
    r = await upload('logo', Buffer.from('GIF89a......'), 'image/png', hr);
    t.check('non-PNG/JPG bytes rejected', r.status === 400, JSON.stringify(r.data));
    r = await upload('logo', Buffer.concat([makePng(8, 8), Buffer.alloc(1100000)]), 'image/png', hr);
    t.check('oversized logo rejected', r.status === 400 || r.status === 413, r.status);
    r = await upload('photo', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000)]), 'image/jpeg', hr);
    t.check('photo upload', r.status === 200 && /\.jpg$/.test(r.data.photoUrl), JSON.stringify(r.data));
    r = await call('PATCH', '/admin/branding', { focusX: 30, focusY: 70, dim: false }, hr);
    t.check('focus point + dim saved', r.data.photoFocus.x === 30 && r.data.photoFocus.y === 70 && r.data.photoDim === false, JSON.stringify(r.data));
    r = await call('PATCH', '/admin/branding', { focusX: 300 }, hr);
    t.check('focus out of range rejected', r.status === 400, JSON.stringify(r.data));
    for (const fmt of ['pdf', 'xlsx']) {
      const res = await call('GET', `/team/reports?type=summary&from=${weekAgo}&to=${today}&format=${fmt}`, null, hr, true);
      const buf = Buffer.from(await res.arrayBuffer());
      t.check(`${fmt} includes logo`, res.status === 200 && (fmt === 'pdf' ? /\/Subtype \/Image/.test(buf.toString('latin1')) : buf.toString('latin1').includes('xl/media/')), res.status);
    }
    r = await upload('logo', makePng(32, 32), 'image/png', hr);
    media = await fetch(srv.base + logoUrl);
    t.check('replacing logo deletes old file', r.data.logoUrl !== logoUrl && media.status === 404, media.status);
    r = await call('DELETE', '/admin/branding/logo', null, hr);
    t.check('remove logo', r.data.logoUrl === null, JSON.stringify(r.data));
    media = await fetch(srv.base + '/media/..%2findex.js');
    t.check('media cannot read other files', media.status >= 400 && !(await media.text()).includes('import express'), media.status);
    media = await fetch(srv.base + '/media/%2e%2e%2f%2e%2e%2fserver%2fdb.js');
    t.check('media blocks encoded traversal', media.status >= 400, media.status);

    // --- suspend + support access
    const list = (await call('GET', '/platform/institutions', null, owner)).data;
    const clinicInst = list.find((i) => i.code === 'demo-clinic');
    r = await call('POST', `/platform/institutions/${clinicInst.id}/support`, null, owner);
    t.check('support session issued', r.data.token && r.data.institution.code === 'demo-clinic', JSON.stringify(r.data));
    const support = r.data.token;
    r = await call('GET', '/admin/users', null, support);
    t.check('support session sees clinic users', r.status === 200 && r.data.length === 2, JSON.stringify(r.data));
    r = await call('POST', '/attendance/check-in', { lat: 0, lng: 0, accuracy: 5 }, support);
    t.check('support cannot check in', r.status === 403, JSON.stringify(r.data));
    r = await call('GET', '/platform/institutions', null, support);
    t.check('support token cannot use platform API', r.status === 403, JSON.stringify(r.data));
    r = await call('PATCH', `/platform/institutions/${clinicInst.id}`, { status: 'suspended' }, owner);
    t.check('suspend institution', r.data.status === 'suspended', JSON.stringify(r.data));
    r = await call('GET', '/admin/users', null, clinic);
    t.check('suspended institution sessions blocked', r.status === 403, JSON.stringify(r.data));
    r = await call('POST', '/auth/login', { institution: 'demo-clinic', email: 'admin@clinic.test', password: 'clinic-pass-1' });
    t.check('suspended institution login blocked', r.status === 403, JSON.stringify(r.data));

    // --- institution search
    r = await call('GET', '/auth/institutions?q=ng');
    t.check('search finds NGA by partial name', r.data.length === 1 && r.data[0].code === 'nga', JSON.stringify(r.data));
    r = await call('GET', '/auth/institutions?q=clinic');
    t.check('search hides suspended institutions', r.data.length === 0, JSON.stringify(r.data));
    r = await call('GET', '/auth/institutions?q=n');
    t.check('search needs 2+ characters', Array.isArray(r.data) && r.data.length === 0, JSON.stringify(r.data));
    r = await call('GET', '/auth/institutions?q=%25');
    t.check('search treats % literally', r.data.length === 0, JSON.stringify(r.data));
    await call('PATCH', `/platform/institutions/${clinicInst.id}`, { status: 'active' }, owner);
    r = await call('GET', '/auth/institutions?q=demo');
    t.check('search by code finds clinic', r.data.some((i) => i.code === 'demo-clinic'), JSON.stringify(r.data));
  } catch (e) {
    t.fail(e);
  } finally {
    await srv.stop();
  }
  return t.done(srv);
}
