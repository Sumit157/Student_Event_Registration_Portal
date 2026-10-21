'use strict';

/**
 * scripts/externalize-inline-scripts.js
 *
 * One-off migration: moves each page's inline <script> bootstrap into an
 * external file under client/js/pages/, and rewrites the tag to <script src>.
 *
 * WHY: app.js sets a strict Helmet CSP (script-src 'self') which BLOCKS inline
 * scripts. As a result no page could bootstrap (Auth was undefined, login fell
 * back to a native GET submit, dashboards never populated). Externalizing the
 * boot code keeps the CSP strict (no 'unsafe-inline') while making the pages
 * actually work. The script bodies are moved VERBATIM (no 'use strict' added)
 * so behavior is byte-for-byte identical to the original inline code.
 *
 * Idempotent: if a page already references an external page script, it is
 * skipped.
 *
 *   node scripts/externalize-inline-scripts.js
 */

const fs = require('fs');
const path = require('path');

const CLIENT = path.join(__dirname, '..', 'client');
const PAGES_DIR = path.join(CLIENT, 'js', 'pages');

const INLINE_RE = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/;

function main() {
  fs.mkdirSync(PAGES_DIR, { recursive: true });

  const files = fs.readdirSync(CLIENT).filter((f) => f.endsWith('.html')).sort();
  const migrated = [];
  const skipped = [];

  for (const file of files) {
    const full = path.join(CLIENT, file);
    // Read as UTF-8 so ellipses/bullets/emoji survive intact.
    const html = fs.readFileSync(full, 'utf8');
    const match = html.match(INLINE_RE);

    if (!match) {
      skipped.push(`${file} (no inline script)`);
      continue;
    }

    const code = match[1];
    const bootName = file.replace(/\.html$/, '.js');
    const bootPath = path.join(PAGES_DIR, bootName);
    const tag = `<script src="/js/pages/${bootName}"></script>`;

    if (html.includes(`/js/pages/${bootName}`)) {
      skipped.push(`${file} (already external)`);
      continue;
    }

    // Write the boot file exactly as it appeared inline.
    fs.writeFileSync(bootPath, code, 'utf8');

    // Replace the inline script tag with the external reference.
    const updated = html.replace(INLINE_RE, tag);
    if (updated === html) {
      console.log(`  SKIP ${file}: replace produced no change`);
      continue;
    }
    fs.writeFileSync(full, updated, 'utf8');
    migrated.push(`${file} -> js/pages/${bootName}`);
  }

  console.log(`Migrated ${migrated.length} page(s):`);
  for (const m of migrated) console.log(`  ${m}`);
  if (skipped.length) {
    console.log(`\nSkipped ${skipped.length}:`);
    for (const s of skipped) console.log(`  ${s}`);
  }

  // Safety check: no inline <script> without src should remain.
  const leftovers = [];
  for (const file of files) {
    const html = fs.readFileSync(path.join(CLIENT, file), 'utf8');
    if (INLINE_RE.test(html)) leftovers.push(file);
  }
  if (leftovers.length) {
    console.error('\nERROR: inline scripts still present in: ' + leftovers.join(', '));
    process.exit(1);
  }
  console.log('\nVerified: no inline <script> blocks remain. CSP script-src \'self\' is satisfied.');
}

main();
