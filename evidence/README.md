# Evidence — screenshots

Genuine screenshots of the running portal, captured at three responsive widths
and across all three roles.

## What is here

- `screenshots/*.png` — **57 images**, named `<role>-<view>-<width>.png`
  (e.g. `student-dashboard-375.png`, `anon-event-detail-full-1366.png`).
- `screenshots/manifest.json` — machine-readable index: capture time, base URL,
  the three viewports, the file list, and any failures (none on the shipped run).

| Prefix | Meaning |
|--------|---------|
| `anon-` | Not signed in (public pages) |
| `student-` | Signed in as a seeded student |
| `alumni-` | Signed in as an approved alumnus |
| `admin-`  | Signed in as an administrator |
| suffix `-1366` / `-768` / `-375` | Desktop / tablet / mobile viewport width |

## How they were produced

`scripts/capture-screenshots.js` drives a **real Chrome** (via `puppeteer-core`)
against the **running server** (`http://localhost:5000`). For each role it signs
in through the actual login form, then visits each page and takes a full-page
screenshot. Nothing is mocked, staged, or hand-edited — the pages show live data
from the seeded database.

The `event-detail` shots deliberately include one **open** event and one
**full / waitlisted** event so the waitlist UI is evidenced.

### Regenerating

```powershell
# 1. Start the server
npm.cmd run dev

# 2. (Optional) raise rate limits so the ~57-page crawl does not trip them.
#    This only sets process env for the server you launch - no app change.
$env:RATE_LIMIT_MAX = "100000"
$env:LOGIN_RATE_LIMIT_MAX = "1000"

# 3. Capture
node scripts/capture-screenshots.js
```

> The capture makes 3 sign-ins and ~135 API calls. Without the raised limits the
> app's own protective rate limiter (100 req/15 min, 5 logins/15 min) will
> correctly throttle the later requests — that is the app working as intended,
> not a bug. Raising the limits for the capture run avoids fighting it.

## How they were verified

- The student and admin dashboards, the events list, and both event-detail
  states were **inspected visually** — they render populated data (stats,
  registrations, seat counts, waitlist notices), not loading spinners or error
  states.
- `scripts/probe-ui.js` confirms the pages boot with **zero CSP/console
  errors** and that login authenticates through JavaScript (redirect to the
  role dashboard, credentials never placed in the URL).
- `scripts/probe-navbar.js` confirms the responsive nav: on desktop the account
  controls sit on the right; on mobile they are hidden until the hamburger is
  opened, then folded into the dropdown.
