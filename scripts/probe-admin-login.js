'use strict';
/** Diagnostic: admin sign-in via the real UI. Reports URL, errors, and the
 *  #login-error slot so we can tell rate-limiting from a navigation issue. */
const puppeteer = require('puppeteer-core');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://localhost:5000';

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 120)); });
  page.on('pageerror', (e) => errs.push('PAGEERR ' + e.message));
  await page.setViewport({ width: 1366, height: 768 });

  await page.goto(`${BASE}/login.html`, { waitUntil: 'networkidle0' });
  await page.type('#email', 'admin@college.edu');
  await page.type('#password', 'Portal#Admin2026');

  // Click and observe what happens over the next 8 seconds.
  await page.click('#login-form [type="submit"]');

  for (const delay of [1500, 3000, 6000]) {
    await new Promise((r) => setTimeout(r, delay === 1500 ? 1500 : 3000));
    const state = await page.evaluate(() => ({
      url: location.pathname + location.search,
      loginError: (document.getElementById('login-error') || {}).innerText || '',
    }));
    console.log(`t~${delay}ms -> url=${state.url} | loginError="${state.loginError.replace(/\s+/g, ' ').trim()}"`);
  }
  console.log('console errors:', errs.length, errs.slice(0, 4));
  await browser.close();
})().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });
