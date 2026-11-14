// Institution isolation: every admin and platform route is tried by the wrong people.
// - no login -> 401, an employee -> 403, an institution admin on platform routes -> 403
// - an admin of institution B (and a support session for B) must never see or change
//   institution A's people, devices, settings, branding, reports or security log.
// The route list is read from index.js, so a new admin route without a test here fails the suite.
import fs from 'node:fs';
import path from 'node:path';
import { startServer, loginWithCode, reporter, makePng, kigaliDate, SERVER_DIR } from './helpers.mjs';

function routeInventory() {
  const src = fs.readFileSync(path.join(SERVER_DIR, 'index.js'), 'utf8');
  const routes = new Set();
  for (const m of src.matchAll(/^\s*(admin|platform)\.(get|post|put|patch|delete)\(\s*[`'"]([^`'"]+)[`'"]/gm)) {
    const [, router, method, p] = m;
    const paths = p.includes('${kind}') ? ['logo', 'photo'].map((k) => p.replace('${kind}', k)) : [p];
    for (const one of paths) routes.add(`${method.toUpperCase()} /${router}${one}`);
  }
  return routes;
}

export async function run() {
  const t = reporter('Institution isolation');
  const srv = await startServer();
  const { call } = srv;
  try {
    // --- two institutions, each with an admin and an employee
    let r = await call('POST', '/auth/login', { email: 'owner@test.local', password: 'ownerpass1' });
    r = await call('POST', '/auth/verify', { challenge: r.data.challenge, code: srv.lastCode() });
    const owner = r.data.token;
    for (const [name, code, email] of [['Alpha', 'alpha', 'admin@alpha.test'], ['Beta', 'beta', 'admin@beta.test']]) {
      await call('POST', '/platform/institutions', { name, code, timezone: 'Africa/Kigali', adminName: `${name} Admin`, adminEmail: email }, owner);
      await call('POST', '/auth/reset', { token: srv.lastLink(), password: 'admin-pass-1' });
    }
    const A = (await loginWithCode(srv, 'alpha', 'admin@alpha.test', 'admin-pass-1')).token;
    const B = (await loginWithCode(srv, 'beta', 'admin@beta.test', 'admin-pass-1')).token;
    await call('PUT', '/admin/settings', { officeLat: -1.944, officeLng: 30.0619, workStart: '00:00', workEnd: '23:59', graceMinutes: 0, workDays: [0, 1, 2, 3, 4, 5, 6], alertEmails: 'alpha-alerts@alpha.test' }, A);
    await call('PUT', '/admin/settings', { alertEmails: 'beta-alerts@beta.test' }, B);
    await call('POST', '/admin/users', { name: 'Alpha Worker', email: 'worker@alpha.test', password: 'worker-pass-1' }, A);
    await call('POST', '/admin/users', { name: 'Beta Worker', email: 'worker@beta.test', password: 'worker-pass-1' }, B);
    const aWorker = await loginWithCode(srv, 'alpha', 'worker@alpha.test', 'worker-pass-1', true);
    const bWorker = (await loginWithCode(srv, 'beta', 'worker@beta.test', 'worker-pass-1')).token;
    await call('POST', '/attendance/check-in', { lat: -1.9442, lng: 30.062, accuracy: 10 }, aWorker.token);
    const logoRes = await fetch(`${srv.base}/api/admin/branding/logo`, { method: 'PUT', headers: { 'Content-Type': 'image/png', Authorization: `Bearer ${A}` }, body: makePng(64, 64) });
    const aLogo = (await logoRes.json()).logoUrl;
    await call('PATCH', '/admin/branding', { focusX: 20, focusY: 80 }, A);

    const aUsers = (await call('GET', '/admin/users', null, A)).data;
    const aWorkerId = aUsers.find((u) => u.email === 'worker@alpha.test').id;
    const aDeviceId = (await call('GET', '/admin/security', null, A)).data.devices[0]?.id;
    t.check('setup: alpha has data to protect', aWorkerId && aDeviceId && aLogo, JSON.stringify({ aWorkerId, aDeviceId, aLogo }));
    const alphaNames = /alpha/i;
    const leaks = (data) => alphaNames.test(JSON.stringify(data));
    const today = kigaliDate();

    // --- what B's admin tries on each admin route, and what must hold afterwards
    const adminCases = {
      'GET /admin/attendance': async (tok) => {
        const x = await call('GET', `/admin/attendance?from=${today}&to=${today}`, null, tok);
        return x.status === 200 && !leaks(x.data);
      },
      'GET /admin/users': async (tok) => {
        const x = await call('GET', '/admin/users', null, tok);
        return x.status === 200 && !leaks(x.data);
      },
      'POST /admin/users': async (tok) => {
        const x = await call('POST', '/admin/users', { name: 'Copy', email: `copy-${Math.random()}@x.test`, password: 'copy-pass-1' }, tok);
        const aNow = (await call('GET', '/admin/users', null, A)).data;
        return x.status === 201 && aNow.length === aUsers.length;
      },
      'POST /admin/users/:id/invite': async (tok) => (await call('POST', `/admin/users/${aWorkerId}/invite`, null, tok)).status === 404,
      'PATCH /admin/users/:id': async (tok) => {
        const x = await call('PATCH', `/admin/users/${aWorkerId}`, { name: 'Hijacked', active: false }, tok);
        const still = (await call('GET', '/admin/users', null, A)).data.find((u) => u.id === aWorkerId);
        return x.status === 404 && still.name === 'Alpha Worker' && still.active;
      },
      'GET /admin/settings': async (tok) => {
        const x = await call('GET', '/admin/settings', null, tok);
        return x.status === 200 && !leaks(x.data);
      },
      'PUT /admin/settings': async (tok) => {
        await call('PUT', '/admin/settings', { alertEmails: 'beta-alerts@beta.test', radiusMeters: 999 }, tok);
        const a = (await call('GET', '/admin/settings', null, A)).data.settings;
        return a.alertEmails === 'alpha-alerts@alpha.test' && a.radiusMeters !== 999;
      },
      'POST /admin/test-email': async (tok) => {
        const before = srv.log.length;
        await call('POST', '/admin/test-email', null, tok);
        return !srv.log.slice(before).includes('alpha-alerts@alpha.test');
      },
      'GET /admin/security': async (tok) => {
        const x = await call('GET', '/admin/security', null, tok);
        return x.status === 200 && !leaks(x.data);
      },
      'DELETE /admin/devices/:id': async (tok) => (await call('DELETE', `/admin/devices/${aDeviceId}`, null, tok)).status === 404,
      'POST /admin/devices/forget-all': async (tok) => {
        await call('POST', '/admin/devices/forget-all', null, tok);
        return (await call('GET', '/admin/security', null, A)).data.devices.some((d) => d.id === aDeviceId);
      },
      'GET /admin/reports': async (tok) => {
        const all = await call('GET', `/admin/reports?type=daily&from=${today}&to=${today}`, null, tok);
        const targeted = await call('GET', `/admin/reports?type=daily&from=${today}&to=${today}&userId=${aWorkerId}`, null, tok);
        const file = await call('GET', `/admin/reports?type=daily&from=${today}&to=${today}&userId=${aWorkerId}&format=csv`, null, tok, true);
        return !leaks(all.data) && !leaks(targeted.data) && !/alpha/i.test(await file.text());
      },
      'POST /admin/reports/email': async (tok) => {
        const before = srv.log.length;
        await call('POST', '/admin/reports/email', { type: 'daily', from: today, to: today, userId: aWorkerId, format: 'csv' }, tok);
        return !/To: [^\n]*alpha/i.test(srv.log.slice(before));
      },
      'GET /admin/branding': async (tok) => {
        const x = await call('GET', '/admin/branding', null, tok);
        return x.status === 200 && x.data.logoUrl !== aLogo;
      },
      'PUT /admin/branding/logo': async (tok) => {
        await fetch(`${srv.base}/api/admin/branding/logo`, { method: 'PUT', headers: { 'Content-Type': 'image/png', Authorization: `Bearer ${tok}` }, body: makePng(16, 16) });
        return (await call('GET', '/admin/branding', null, A)).data.logoUrl === aLogo;
      },
      'PUT /admin/branding/photo': async (tok) => {
        await fetch(`${srv.base}/api/admin/branding/photo`, { method: 'PUT', headers: { 'Content-Type': 'image/png', Authorization: `Bearer ${tok}` }, body: makePng(16, 16) });
        return (await call('GET', '/admin/branding', null, A)).data.photoUrl === null;
      },
      'DELETE /admin/branding/logo': async (tok) => {
        await call('DELETE', '/admin/branding/logo', null, tok);
        return (await call('GET', '/admin/branding', null, A)).data.logoUrl === aLogo;
      },
      'DELETE /admin/branding/photo': async (tok) => {
        await call('DELETE', '/admin/branding/photo', null, tok);
        return (await call('GET', '/admin/branding', null, A)).data.logoUrl === aLogo;
      },
      'PATCH /admin/branding': async (tok) => {
        await call('PATCH', '/admin/branding', { focusX: 90, focusY: 10 }, tok);
        const a = (await call('GET', '/admin/branding', null, A)).data.photoFocus;
        return a.x === 20 && a.y === 80;
      },
    };

    // A route the server defines but this file doesn't test is a failure.
    const inventory = routeInventory();
    const adminRoutes = [...inventory].filter((k) => k.includes(' /admin/'));
    const untested = adminRoutes.filter((k) => !adminCases[k]);
    t.check(`every admin route has an isolation test (${adminRoutes.length} routes)`, untested.length === 0, `untested: ${untested.join(', ')}`);

    // Unauthenticated and employee access to every admin route.
    for (const key of adminRoutes) {
      const [method, full] = key.split(' ');
      const p = full.replace('/admin', '/admin').replace(':id', String(aWorkerId));
      const anon = await call(method, p, method === 'GET' || method === 'DELETE' ? undefined : {});
      const emp = await call(method, p, method === 'GET' || method === 'DELETE' ? undefined : {}, bWorker);
      t.check(`${key}: no login 401, employee 403`, anon.status === 401 && emp.status === 403, `${anon.status}/${emp.status}`);
    }

    // B's admin, then a support session for B, against A's data.
    const betaId = (await call('GET', '/platform/institutions', null, owner)).data.find((i) => i.code === 'beta').id;
    const supportB = (await call('POST', `/platform/institutions/${betaId}/support`, null, owner)).data.token;
    for (const [who, tok] of [['beta admin', B], ['support session for beta', supportB]]) {
      for (const key of adminRoutes) {
        if (!adminCases[key]) continue;
        let ok = false;
        try {
          ok = await adminCases[key](tok);
        } catch (e) {
          ok = false;
        }
        t.check(`${who}: ${key} cannot reach alpha`, ok);
      }
    }

    // Platform routes are for the platform owner only.
    const platformRoutes = [...inventory].filter((k) => k.includes(' /platform/'));
    t.check(`platform routes found (${platformRoutes.length})`, platformRoutes.length >= 5, platformRoutes.join(', '));
    const alphaId = (await call('GET', '/platform/institutions', null, owner)).data.find((i) => i.code === 'alpha').id;
    for (const key of platformRoutes) {
      const [method, full] = key.split(' ');
      const p = full.replace(':id', String(alphaId));
      const body = method === 'GET' ? undefined : { status: 'suspended', name: 'x', code: 'zz', adminName: 'x', adminEmail: 'x@x.io' };
      const codes = [];
      for (const tok of [undefined, aWorker.token, B, supportB]) codes.push((await call(method, p, body, tok)).status);
      t.check(`${key}: only the platform owner (got ${codes.join('/')})`, codes[0] === 401 && codes.slice(1).every((c) => c === 403));
    }
    const alphaNow = (await call('GET', '/platform/institutions', null, owner)).data.find((i) => i.code === 'alpha');
    t.check('alpha still active and unchanged after all attempts', alphaNow.status === 'active' && alphaNow.name === 'Alpha', JSON.stringify(alphaNow));

    // Employees only ever see their own institution.
    r = await call('GET', '/me', null, bWorker);
    t.check('employee /me shows only own institution', r.data.institution.code === 'beta' && !leaks(r.data), JSON.stringify(r.data.institution));
  } catch (e) {
    t.fail(e);
  } finally {
    await srv.stop();
  }
  return t.done(srv);
}
