'use strict';

/**
 * scripts/capture-screenshots.js
 * Captures GENUINE screenshots of the running portal at 3 responsive widths
 * (1366 desktop, 768 tablet, 375 mobile) into evidence/screenshots/.
 *
 * Nothing here is mocked or hand-composed: it drives the real browser against
 * the real server, signs in as each role, and screenshots the real pages.
 *
 *   node scripts/capture-screenshots.js
 *
 * Requires: server running on :5000 and Chrome installed (auto-detected).
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const BASE = process.env.SMOKE_BASE || 'http://localhost:5000';
const OUT_DIR = path.join(__dirname, '..', 'evidence', 'screenshots');

const VIEWPORTS = [
  { name: '1366', width: 1366, height: 768 },  // desktop
  { name: '768', width: 768, height: 1024 },   // tablet
  { name: '375', width: 375, height: 812 },    // mobile (also exercises hamburger nav)
];

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('No Chrome/Edge found. Set CHROME_PATH to a Chrome executable.');
}

const CREDS = {
  student: { email: 'aarav.student@example.com', password: 'SeedDev#2026' },
  alumni: { email: 'ananya.alum@example.com', password: 'SeedDev#2026' },
  admin: { email: 'admin@college.edu', password: 'Portal#Admin2026' },
};

// Pages to capture per signed-in role.
const ROLE_PAGES = {
  student: [
    { view: 'dashboard', url: '/student-dashboard.html' },
    { view: 'my-registrations', url: '/my-registrations.html' },
    { view: 'events', url: '/events.html' },
  ],
  alumni: [
    { view: 'dashboard', url: '/alumni-dashboard.html' },
    { view: 'directory', url: '/alumni-directory.html' },
    { view: 'jobs', url: '/jobs.html' },
    { view: 'news', url: '/news.html' },
    { view: 'connections', url: '/connections.html' },
    { view: 'profile', url: '/profile.html' },
  ],
  admin: [
    { view: 'dashboard', url: '/admin.html' },
    { view: 'users', url: '/admin.html#users' },
    { view: 'alumni-approval', url: '/admin.html#alumni' },
    { view: 'registrations', url: '/admin.html#registrations' },
  ],
};

const captured = [];
const failed = [];

function shot(page, name) {
  return page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage: true });
}

/** Navigate and wait for the silent-refresh + render to settle. */
async function visit(page, url) {
  // `domcontentloaded` guarantees the DOM exists; then give the network a
  // BOUNDED chance to go idle. The admin pages fire many parallel requests,
  // so an unbounded networkidle0 wait could throw on a slow-but-healthy page.
  await page.goto(`${BASE}${url}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  try {
    await page.waitForNetworkIdle({ idleTime: 600, timeout: 15000 });
  } catch (e) { /* slow page: fall through to the fixed settle delay */ }
  // Give the silent /api/auth/refresh + data fetches a moment to paint.
  await new Promise((r) => setTimeout(r, 900));
}

async function signIn(page, role) {
  await visit(page, '/login.html');
  await page.type('#email', CREDS[role].email);
  await page.type('#password', CREDS[role].password);
  // On success the app redirects (window.location), which produces a real
  // navigation. Wait for THAT rather than network idle, which is unreliable
  // on the request-heavy dashboards. On failure there is no navigation, so
  // this times out and is reported as a sign-in failure.
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }),
    page.click('#login-form [type="submit"]'),
  ]);
  try {
    await page.waitForNetworkIdle({ idleTime: 600, timeout: 15000 });
  } catch (e) { /* ignore */ }
  await new Promise((r) => setTimeout(r, 900));
}

async function main() {
  // Health check first - never capture a dead server.
  try {
    const res = await fetch(`${BASE}/api/health`);
    if (!res.ok) throw new Error(`health ${res.status}`);
  } catch (e) {
    console.error(`Server is not reachable at ${BASE} - start it first (npm run dev).`);
    console.error(`Reason: ${e.message}`);
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Pick real events for the detail screenshots: one open, one full/waitlisted.
  // The LIST endpoint exposes flat seat fields (capacity, confirmedCount,
  // waitlistedCount, seatsRemaining); the nested `capacityInfo` object only
  // exists on the single-event DETAIL endpoint.
  const list = await (await fetch(`${BASE}/api/events?pageSize=50`)).json();
  const events = list?.data?.events || [];
  const openEvent = events.find((e) => (e.seatsRemaining ?? 1) > 0) || events[0];
  // Prefer a full event that actually has a waitlisted queue (shows the
  // waitlist UI), else any full event, else fall back to the open one.
  const fullEvent = events.find((e) => e.seatsRemaining === 0 && (e.waitlistedCount ?? 0) > 0)
    || events.find((e) => e.seatsRemaining === 0)
    || openEvent;

  const executablePath = process.env.CHROME_PATH || findChrome();
  console.log(`Browser: ${executablePath}`);
  console.log(`Server : ${BASE}`);
  console.log(`Open event: #${openEvent?.id} | Full event: #${fullEvent?.id}\n`);

  const browser = await puppeteer.launch({
    executablePath,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
  });

  try {
    // ---------------------------------------------------------------------
    // Phase 1: public/anonymous pages at each viewport (no sign-in, so these
    // do not consume the login rate-limit budget).
    // ---------------------------------------------------------------------
    const anonPages = [
      { view: 'home', url: '/index.html' },
      { view: 'events', url: '/events.html' },
      { view: 'event-detail-open', url: `/event-detail.html?id=${openEvent?.id}` },
      { view: 'event-detail-full', url: `/event-detail.html?id=${fullEvent?.id}` },
      { view: 'login', url: '/login.html' },
      { view: 'register', url: '/register.html' },
    ];

    for (const vp of VIEWPORTS) {
      console.log(`--- viewport ${vp.name}px (anonymous) ---`);
      const anon = await browser.createBrowserContext();
      const aPage = await anon.newPage();
      await aPage.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1 });

      for (const p of anonPages) {
        const name = `anon-${p.view}-${vp.name}`;
        try {
          await visit(aPage, p.url);
          await shot(aPage, name);
          captured.push(name);
          console.log(`  captured ${name}`);
        } catch (e) {
          failed.push(`${name}: ${e.message}`);
          console.log(`  FAILED   ${name}: ${e.message}`);
        }
      }
      await anon.close();
    }

    // ---------------------------------------------------------------------
    // Phase 2: signed-in roles. SIGN IN EXACTLY ONCE PER ROLE (3 logins
    // total), then reuse that authenticated browser context across all three
    // viewports. Signing in per-viewport would need 9 logins and trip the
    // login rate limiter (5 attempts / 15 min per IP).
    // ---------------------------------------------------------------------
    for (const role of ['student', 'alumni', 'admin']) {
      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      await page.setViewport({ width: VIEWPORTS[0].width, height: VIEWPORTS[0].height, deviceScaleFactor: 1 });

      try {
        await signIn(page, role);
        console.log(`--- signed in as ${role} (1 login, reused for all viewports) ---`);
      } catch (e) {
        failed.push(`sign-in(${role}): ${e.message}`);
        console.log(`  FAILED   sign-in ${role}: ${e.message}`);
        await ctx.close();
        continue;
      }

      for (const vp of VIEWPORTS) {
        await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1 });
        for (const p of ROLE_PAGES[role]) {
          const name = `${role}-${p.view}-${vp.name}`;
          try {
            await visit(page, p.url);
            await shot(page, name);
            captured.push(name);
            console.log(`  captured ${name}`);
          } catch (e) {
            failed.push(`${name}: ${e.message}`);
            console.log(`  FAILED   ${name}: ${e.message}`);
          }
        }
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Screenshots: ${captured.length} captured, ${failed.length} failed`);
  console.log(`Output     : ${OUT_DIR}`);
  if (failed.length) {
    console.log('\nFailures:');
    for (const f of failed) console.log(`  - ${f}`);
  }
  console.log('='.repeat(60));

  // Emit a manifest for the evidence directory.
  const manifest = {
    capturedAt: new Date().toISOString(),
    base: BASE,
    viewports: VIEWPORTS.map((v) => ({ name: v.name, width: v.width, height: v.height })),
    total: captured.length,
    failed,
    files: captured.sort(),
  };
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('Capture crashed:', err);
  process.exit(1);
});
