'use strict';
/**
 * scripts/probe-ui.js
 * Diagnostic: does the CSP actually block the inline Auth.boot() bootstrap?
 * Reports console CSP errors and whether dynamic content rendered.
 */
const puppeteer = require('puppeteer-core');

const CHROME = process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://localhost:5000';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new', args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  let errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });
  page.on('pageerror', (e) => errs.push('PAGEERR ' + e.message));
  await page.setViewport({ width: 1366, height: 768 });

  console.log('--- login.html (anonymous) ---');
  await page.goto(`${BASE}/login.html`, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 800));
  console.log('csp/console errors:', errs.length, errs.slice(0, 3));
  console.log('nav filled:', await page.evaluate(() =>
    (document.getElementById('shell-nav').innerText || '').trim().length > 0));
  console.log('Auth global exists:', await page.evaluate(() => typeof window.Auth));

  console.log('\n--- real UI login ---');
  errs = [];
  await page.type('#email', 'aarav.student@example.com');
  await page.type('#password', 'SeedDev#2026');
  await page.click('#login-form [type="submit"]');
  await new Promise((r) => setTimeout(r, 3500));
  console.log('url after login:', page.url());
  console.log('errors:', errs.length, errs.slice(0, 3));

  console.log('\n--- student-dashboard.html (after login) ---');
  errs = [];
  await page.goto(`${BASE}/student-dashboard.html`, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 1800));
  console.log('url:', page.url());
  console.log('errors:', errs.length, errs.slice(0, 3));
  const s = await page.evaluate(() => ({
    nav: (document.getElementById('shell-nav').innerText || '').replace(/\s+/g, ' ').trim().slice(0, 140),
    cards: [...document.querySelectorAll('.card, .stat')]
      .map((e) => e.innerText.replace(/\s+/g, ' ').trim()).slice(0, 4),
    bodyLen: document.body.innerText.length,
    hasSpinner: /Loading/.test(document.body.innerText),
  }));
  console.log('nav:', s.nav);
  console.log('cards:', JSON.stringify(s.cards, null, 1));
  console.log('bodyLen:', s.bodyLen, '| hasLoading:', s.hasSpinner);

  console.log('\n--- event-detail.html (anonymous) ---');
  const anon = await browser.createBrowserContext();
  const p2 = await anon.newPage();
  let errs2 = [];
  p2.on('console', (m) => { if (m.type() === 'error') errs2.push(m.text().slice(0, 160)); });
  await p2.setViewport({ width: 1366, height: 768 });
  await p2.goto(`${BASE}/event-detail.html?id=13`, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 2500));
  console.log('errors:', errs2.length, errs2.slice(0, 3));
  const e2 = await p2.evaluate(() => ({
    text: (document.getElementById('event-detail') || {}).innerText || '',
    bodyLen: document.body.innerText.length,
  }));
  console.log('event-detail slot:', JSON.stringify(e2.text.replace(/\s+/g, ' ').trim().slice(0, 200)));
  console.log('bodyLen:', e2.bodyLen);

  await browser.close();
})().catch((e) => { console.error('probe failed:', e); process.exit(1); });
