'use strict';
/**
 * scripts/smoke.js
 * End-to-end smoke test against a RUNNING server (default http://localhost:5000).
 *
 * This is deliberately separate from the automated test suite: it drives the
 * real HTTP server over the network, exactly as a browser would, and prints a
 * readable report. It creates its own throwaway records and cleans them up.
 *
 *   node scripts/smoke.js            # uses http://localhost:5000
 *   SMOKE_BASE=http://host:port node scripts/smoke.js
 */

const BASE = process.env.SMOKE_BASE || 'http://localhost:5000';

// Minimal cookie jar so the HttpOnly refresh cookie behaves like a browser jar.
const jar = new Map();
function cookieHeader() {
  const pairs = [...jar.entries()].map(([k, v]) => `${k}=${v}`);
  return pairs.length ? pairs.join('; ') : undefined;
}
function storeCookies(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const line of raw) {
    const [pair] = line.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}

let accessToken = null;

async function call(method, path, { body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const ck = cookieHeader();
  if (ck) headers.Cookie = ck;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  storeCookies(res);

  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch { /* non-JSON (e.g. CSV/HTML) */ }
  return { status: res.status, json, text, headers: res.headers };
}

function signIn(email, password) {
  return call('POST', '/api/auth/login', { body: { email, password }, auth: false });
}

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

const rnd = Math.floor(Math.random() * 1e9);
const throwaway = {
  email: `smoke.student.${rnd}@portal-test.local`,
  password: 'SmokeTest#2026',
  name: 'Smoke Test Student',
};

async function main() {
  console.log(`Smoke test against ${BASE}\n`);

  // ---- Public surface -----------------------------------------------------
  const health = await call('GET', '/api/health', { auth: false });
  check('health endpoint returns 200', health.status === 200, `status=${health.status}`);

  const events = await call('GET', '/api/events', { auth: false });
  const eventCount = events.json?.data?.events?.length ?? 0;
  check('public event list is browsable', events.status === 200 && eventCount > 0,
    `${eventCount} events on page 1`);
  check('event list carries pagination metadata', Boolean(events.json?.data?.pagination),
    `totalPages=${events.json?.data?.pagination?.totalPages}`);

  // Unauthenticated admin access must be refused.
  const noAuthAdmin = await call('GET', '/api/admin/stats', { auth: false });
  check('admin API refuses unauthenticated access', noAuthAdmin.status === 401,
    `status=${noAuthAdmin.status}`);

  // ---- Student ------------------------------------------------------------
  // Register first, THEN sign in - firing these concurrently would race and
  // the login would 401 because the account does not exist yet.
  const reg = await call('POST', '/api/auth/register', {
    body: {
      name: throwaway.name,
      email: throwaway.email,
      password: throwaway.password,
      confirmPassword: throwaway.password,
      role: 'student',
      collegeId: `SMOKE-${rnd}`,
    },
    auth: false,
  });
  check('public registration succeeds as student', reg.status === 201, `status=${reg.status}`);
  check('registration never returns a password hash',
    !JSON.stringify(reg.json || {}).includes('password_hash'));

  const sLogin = await signIn(throwaway.email, throwaway.password);
  check('student can sign in', sLogin.status === 200, `status=${sLogin.status}`);
  accessToken = sLogin.json?.data?.accessToken || sLogin.json?.data?.token;
  check('login returns a short-lived access token', Boolean(accessToken));

  const myRegs = await call('GET', '/api/events/me/registrations');
  check('student can read own registrations', myRegs.status === 200, `status=${myRegs.status}`);

  const studentOnAdmin = await call('GET', '/api/admin/stats');
  check('student is refused by the admin API', studentOnAdmin.status === 403,
    `status=${studentOnAdmin.status}`);

  // Register for the first open (non-full, still upcoming) event and confirm a seat.
  // The list endpoint returns FLAT seatsRemaining (the nested capacityInfo shape
  // only exists on the detail endpoint), and the server refuses registration for a
  // past event with EVENT_PASSED - so require both a free seat and a future start.
  const now = Date.now();
  const open = (events.json?.data?.events || []).find((e) =>
    (e.seatsRemaining ?? e.capacityInfo?.seatsRemaining ?? 0) > 0
    && new Date(e.eventDate).getTime() > now);
  if (open) {
    const r = await call('POST', `/api/events/${open.id}/register`);
    check('student registers for an open event', [201, 409].includes(r.status),
      `status=${r.status} outcome=${r.json?.data?.status || 'n/a'}`);
    check('registration outcome is confirmed or waitlisted',
      ['confirmed', 'waitlisted'].includes(r.json?.data?.status),
      r.json?.data?.status);

    const dup = await call('POST', `/api/events/${open.id}/register`);
    check('duplicate registration is refused with 409', dup.status === 409,
      `code=${dup.json?.error?.code}`);

    const cancel = await call('POST', `/api/events/${open.id}/cancel`);
    check('student can cancel a registration', cancel.status === 200,
      `promotedUserId=${cancel.json?.data?.promotedUserId ?? 'none'}`);
  }

  // ---- Alumni (approved) --------------------------------------------------
  accessToken = null; jar.clear();
  const alumniLogin = signIn('ananya.alum@example.com', 'SeedDev#2026');
  const aLogin = await alumniLogin;
  check('approved alumni can sign in', aLogin.status === 200, `status=${aLogin.status}`);
  accessToken = aLogin.json?.data?.accessToken || aLogin.json?.data?.token;

  const directory = await call('GET', '/api/alumni/directory?pageSize=50', { auth: false });
  check('public alumni directory is browsable', directory.status === 200,
    `${directory.json?.data?.alumni?.length ?? 0} approved profiles`);
  check('directory masks email addresses',
    (directory.json?.data?.alumni || []).every((p) => !p.email || p.email.includes('*')),
    `sample=${directory.json?.data?.alumni?.[0]?.email}`);

  const alumniOnAdmin = await call('GET', '/api/admin/stats');
  check('alumni is refused by the admin API', alumniOnAdmin.status === 403,
    `status=${alumniOnAdmin.status}`);

  const alumniReg = await call('POST', `/api/events/${open ? open.id : 1}/register`);
  check('alumni cannot register for events (students only)', alumniReg.status === 403,
    `status=${alumniReg.status}`);

  // ---- Admin --------------------------------------------------------------
  accessToken = null; jar.clear();
  const adminLogin = signIn('admin@college.edu', 'Portal#Admin2026');
  const adLogin = await adminLogin;
  check('administrator can sign in', adLogin.status === 200, `status=${adLogin.status}`);
  accessToken = adLogin.json?.data?.accessToken || adLogin.json?.data?.token;

  const stats = await call('GET', '/api/admin/stats');
  check('admin can read dashboard statistics', stats.status === 200,
    `users=${stats.json?.data?.users?.total} events=${stats.json?.data?.events?.total}`);

  const users = await call('GET', '/api/admin/users?pageSize=5');
  check('admin can list users', users.status === 200,
    `${users.json?.data?.users?.length ?? 0} returned`);

  const pending = await call('GET', '/api/admin/alumni/pending');
  check('admin can read the alumni approval queue', pending.status === 200,
    `${pending.json?.data?.pending?.length ?? 0} pending`);

  const report = await call('GET', '/api/admin/registrations?pageSize=5');
  check('admin can read the registration report', report.status === 200,
    `${report.json?.data?.registrations?.length ?? 0} rows`);

  // NB: read RAW bytes here. res.text() decodes UTF-8 and strips the BOM, so
  // the BOM must be checked on the byte array (the integration test asserts
  // this too, via the raw response body).
  const csvRes = await fetch(`${BASE}/api/admin/registrations/export`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const csvBytes = Buffer.from(await csvRes.arrayBuffer());
  const csvCt = csvRes.headers.get('content-type') || '';
  const csvCd = csvRes.headers.get('content-disposition') || '';
  check('CSV export is served as text/csv', csvCt.includes('text/csv'), csvCt);
  check('CSV export is offered as a download', csvCd.includes('attachment'), csvCd);
  check('CSV export starts with a UTF-8 BOM',
    csvBytes[0] === 0xEF && csvBytes[1] === 0xBB && csvBytes[2] === 0xBF,
    [...csvBytes.slice(0, 3)].map((x) => x.toString(16)).join(' '));

  // Admin creating an event, then verifying it is publicly visible, then
  // soft-deleting it and confirming it disappears.
  const created = await call('POST', '/api/admin/events', {
    body: {
      title: `Smoke Event ${rnd}`,
      category: 'workshop',
      venue: 'Smoke Lab',
      description: 'Created by the smoke test.',
      capacity: 5,
      eventDate: new Date(Date.now() + 7 * 864e5).toISOString(),
    },
  });
  check('admin can create an event', created.status === 201, `status=${created.status}`);
  const smokeId = created.json?.data?.id;
  if (smokeId) {
    const view = await call('GET', `/api/events/${smokeId}`, { auth: false });
    check('new event is publicly visible', view.status === 200, `status=${view.status}`);

    const removed = await call('DELETE', `/api/admin/events/${smokeId}`);
    check('admin can soft-delete an event', removed.status === 200, `status=${removed.status}`);

    const after = await call('GET', `/api/events/${smokeId}`, { auth: false });
    check('deleted event is no longer publicly reachable', after.status === 404,
      `status=${after.status}`);
  }

  // ---- Summary ------------------------------------------------------------
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`SMOKE TEST: ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('\nFailed checks:');
    for (const f of failed) console.log(`  - ${f.label} ${f.detail}`);
  }
  console.log('='.repeat(60));
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('\nSmoke test crashed:', err.message);
  process.exit(1);
});
