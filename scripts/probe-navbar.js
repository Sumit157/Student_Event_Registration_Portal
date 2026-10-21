'use strict';
/** Verify navbar layout: desktop shows account controls on the right; on
 *  mobile they must be hidden until the hamburger opens the menu. */
const puppeteer = require('puppeteer-core');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://localhost:5000';

function visible(box) { return Boolean(box); }

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });

  // ---- Desktop ----
  const d = await browser.newPage();
  await d.setViewport({ width: 1366, height: 768 });
  await d.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 800));
  const desk = await d.evaluate(() => {
    const actions = document.querySelector('.navbar__actions');
    const links = document.querySelector('.navbar__link');
    const toggle = document.querySelector('.navbar__toggle');
    return {
      actionsVisible: actions ? getComputedStyle(actions).display !== 'none' : false,
      actionsOnRight: actions && links ? actions.getBoundingClientRect().left > links.getBoundingClientRect().left : false,
      toggleHidden: toggle ? getComputedStyle(toggle).display === 'none' : null,
      navHeight: document.querySelector('.navbar__nav')?.getBoundingClientRect().height,
    };
  });
  console.log('DESKTOP 1366:', JSON.stringify(desk));
  await d.screenshot({ path: 'evidence/screenshots/_verify-desktop.png' });

  // ---- Mobile: menu CLOSED ----
  const m = await browser.newPage();
  await m.setViewport({ width: 375, height: 812 });
  await m.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 800));
  const closed = await m.evaluate(() => {
    const actions = document.querySelector('.navbar__actions');
    const toggle = document.querySelector('.navbar__toggle');
    const nav = document.querySelector('.navbar__nav');
    return {
      actionsDisplay: actions ? getComputedStyle(actions).display : 'missing',
      navDisplay: nav ? getComputedStyle(nav).display : 'missing',
      toggleVisible: toggle ? getComputedStyle(toggle).display !== 'none' : false,
      headerHeight: document.querySelector('.navbar')?.getBoundingClientRect().height,
    };
  });
  console.log('MOBILE 375 (closed):', JSON.stringify(closed));
  await m.screenshot({ path: 'evidence/screenshots/_verify-mobile-closed.png' });

  // ---- Mobile: menu OPEN ----
  await m.click('.navbar__toggle');
  await new Promise((r) => setTimeout(r, 400));
  const open = await m.evaluate(() => {
    const actions = document.querySelector('.navbar__actions');
    const nav = document.querySelector('.navbar__nav');
    const firstLink = document.querySelector('.navbar__link');
    const ab = actions?.getBoundingClientRect();
    return {
      navDisplay: nav ? getComputedStyle(nav).display : 'missing',
      actionsDisplay: actions ? getComputedStyle(actions).display : 'missing',
      actionsBelowLinks: ab && firstLink ? ab.top >= firstLink.getBoundingClientRect().top : null,
      actionsWidth: ab ? Math.round(ab.width) : 0,
      menuExpanded: document.querySelector('.navbar__toggle')?.getAttribute('aria-expanded'),
    };
  });
  console.log('MOBILE 375 (open):  ', JSON.stringify(open));
  await m.screenshot({ path: 'evidence/screenshots/_verify-mobile-open.png' });

  await browser.close();
})().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });
