# Student Event Registration & Alumni Portal

A unified college portal combining **student event registration** (with capacity
limits and automatic waitlists) and a **moderated alumni networking directory**.
Built with a vanilla HTML/CSS/JavaScript frontend and a Node.js + Express +
MySQL backend. No frontend framework, no build step.

> **Assignment scope:** Tasks 1–8. See [`SUBMISSION-CHECKLIST.md`](SUBMISSION-CHECKLIST.md)
> for a task-by-task map, and [`TESTING.md`](TESTING.md) / [`SECURITY.md`](SECURITY.md)
> for how the test suite and security controls work.

---

## Table of contents

- [Features](#features)
- [Tech stack](#tech-stack)
- [Project structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Setup (Windows / PowerShell)](#setup-windows--powershell)
- [Setup (macOS / Linux)](#setup-macos--linux)
- [Seeded development accounts](#seeded-development-accounts)
- [Creating the first administrator](#creating-the-first-administrator)
- [Running the tests](#running-the-tests)
- [How the waitlist works](#how-the-waitlist-works)
- [Email in development mode](#email-in-development-mode)
- [API summary](#api-summary)
- [Troubleshooting](#troubleshooting)

---

## Features

**Students**
- Browse and search events (keyword, category, date range), 10 per page.
- See live seat availability and a countdown to each event.
- Register for an event → get a **confirmed** seat, or join the **waitlist**
  (FIFO) when it is full.
- Cancel a registration. Cancelling a confirmed seat **automatically promotes**
  the longest-waiting student and emails them.
- View and manage *My Registrations*.
- Verified-email gate on sensitive actions.

**Alumni**
- Editable profile with bio and a validated avatar upload (type + size checked).
- Alumni directory with search and filters (graduation year, degree, company).
  Profiles are **hidden until an administrator approves them**.
- Connection requests (send / accept / reject) plus a *My Network* view.
- Browse job postings with application deadlines, and post new ones.
- College news feed with paginated comments.

**Administrators**
- Dashboard with registration / user / event statistics.
- Event CRUD, including capacity management (cannot shrink below confirmed seats).
- User search and management: activate / suspend, controlled role changes.
- Alumni approval queue (approve / reject with a reason).
- Registration reports and **CSV export** (spreadsheet-injection safe).
- Bulk email notifications to an event's audience.

**Security**
- Passwords hashed with **bcrypt cost 10**; plain-text passwords and hashes are
  never returned by the API.
- **JWT** access tokens (~15 min, kept in memory) + refresh tokens (7 days,
  HttpOnly cookie, rotating with replay detection).
- Helmet, CORS locked to a configured origin, global + per-route rate limiting.
- `express-validator` on every input; **parameterised SQL** throughout.
- Centralised error handler — stack traces are logged server-side, never sent
  to the client.
- The `admin` role is **not selectable at public registration**.

---

## Tech stack

| Layer      | Technology |
|------------|------------|
| Frontend   | HTML5, CSS3, vanilla ES modules (no framework, no bundler) |
| Backend    | Node.js 20+, Express 4 |
| Database   | MySQL 8 via `mysql2` (pooled, parameterised queries) |
| Auth       | `jsonwebtoken`, `bcryptjs`, HttpOnly cookies |
| Validation | `express-validator`, `sanitize-html` |
| Security   | `helmet`, `cors`, `express-rate-limit` |
| Email      | `nodemailer` (dev fallback prints links to the console) |
| Uploads    | `multer` (memory storage, magic-byte type check) |
| Testing    | Node's built-in `node:test` runner + `supertest` |
| Dev tools  | `nodemon` |

---

## Project structure

```
.
├── app.js                  # Express app factory (createApp) — no listening
├── server.js               # Boots the app, connects the DB pool
├── config/
│   ├── db.js               # mysql2 pool, testConnection(), withTransaction()
│   └── env.js              # env loading + validateEnv()
├── middleware/
│   ├── auth.js             # authenticate / optionalAuthenticate / authorize / requireVerifiedEmail
│   ├── error-handler.js    # centralised errors (never leaks stack traces)
│   ├── rate-limit.js       # global, login, reset and register limiters
│   ├── upload.js           # multer config + magic-byte type validation
│   └── validate.js         # express-validator result handler
├── routes/
│   ├── auth.js             # register, login, refresh, logout, verify, reset
│   ├── events.js           # browse, detail, register, cancel, my registrations
│   ├── alumni.js           # directory, profile editing, avatar upload
│   ├── jobs.js             # job postings
│   ├── connections.js      # connection requests + network
│   ├── news.js             # news + comments
│   ├── profile.js          # the signed-in user's own profile
│   └── admin.js            # every administrator endpoint (admin-only)
├── services/
│   ├── eventService.js     # transactions, row locking, waitlist promotion
│   ├── alumniService.js    # directory queries, approval gating
│   ├── tokenService.js     # JWT + single-use hashed tokens (verify / reset)
│   └── mailer.js           # Nodemailer wrapper, dev console fallback
├── utils/
│   ├── errors.js           # ApiError helpers (notFound, badRequest, …)
│   ├── asyncHandler.js     # async route wrapper
│   ├── csv.js              # RFC-4180 CSV + formula-injection escaping
│   ├── cookies.js          # secure refresh-cookie helpers
│   ├── passwordPolicy.js   # min 8 chars, ≥1 uppercase, ≥1 digit
│   └── sanitize.js         # HTML sanitisation helpers
├── client/                 # static frontend served by Express
│   ├── css/styles.css      # single design system
│   ├── js/                 # api, auth, events, alumni, admin, ui modules
│   │   └── pages/          # one external boot script per page (keeps the
│   │                       #   CSP strict: no inline <script> anywhere)
│   └── *.html              # 17 pages
├── database/schema.sql     # full DDL (11 tables + 1 view, InnoDB)
├── scripts/
│   ├── setup-db.js         # creates DB + least-privilege app user
│   ├── seed.js             # development sample data
│   └── create-admin.js     # creates / promotes the first administrator
├── tests/
│   ├── unit/               # 8 pure-logic test files
│   ├── integration/        # 3 end-to-end API test files (Supertest)
│   └── helpers/            # testEnv, testDb, fixtures
├── uploads/                # avatars (git-ignored; .gitkeep tracked)
├── SECURITY.md
├── TESTING.md
└── SUBMISSION-CHECKLIST.md
```

---

## Prerequisites

- **Node.js 20 or newer** — `node --version`
- **MySQL 8.0+** running locally (or a reachable host), plus the `mysql`
  client on your `PATH` if you want `npm run db:setup` to auto-detect it.
- **npm** (ships with Node).

---

## Setup (Windows / PowerShell)

> PowerShell's execution policy often blocks `npm.ps1`. If you see
> *"running scripts is disabled on this system"*, call `npm.cmd` instead of
> `npm` (that is what the steps below use).

### 1. Install dependencies

```powershell
npm.cmd install
```

### 2. Create your environment file

Copy the template, then edit `.env` and fill in real values:

```powershell
Copy-Item .env.example .env
notepad .env
```

Minimum you must set:

| Variable | Notes |
|----------|-------|
| `DB_HOST`, `DB_PORT`, `DB_NAME` | Where MySQL is and which schema to use |
| `DB_USER`, `DB_PASSWORD` | **Use the least-privilege app user, not root** |
| `JWT_ACCESS_SECRET` | Long random string (e.g. 64 hex chars) |
| `JWT_REFRESH_SECRET` | A *different* long random string |

Generate strong secrets in PowerShell:

```powershell
-join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
```

`.env` is listed in `.gitignore` — never commit it. Every value in
`.env.example` is a placeholder, not a real secret.

### 3. Create the database and the app user

```powershell
npm.cmd run db:setup
```

This reads your MySQL **root** password from a hidden prompt (or the
`MYSQL_ROOT_PASSWORD` environment variable) and then:

1. creates the `student_portal` database,
2. creates a least-privilege user `student_portal_app` with only
   `SELECT, INSERT, UPDATE, DELETE` on that schema,
3. applies `database/schema.sql`,
4. verifies the app user can reach every table.

The application itself **never connects as root**.

### 4. (Optional) Load development sample data

```powershell
npm.cmd run db:seed
```

Creates sample users, events (including a deliberately **full** event with two
waitlisted students), news, jobs and connection requests.

### 5. Create the first administrator

```powershell
npm.cmd run create-admin
```

See [Creating the first administrator](#creating-the-first-administrator).

### 6. Start the server

```powershell
npm.cmd run dev      # auto-restart via nodemon
# or
npm.cmd start        # plain node
```

Open **http://localhost:5000** — Express serves both the API and the static
frontend from the same origin.

---

## Setup (macOS / Linux)

```bash
npm install
cp .env.example .env        # then edit it
npm run db:setup            # hidden root-password prompt
npm run db:seed             # optional
npm run create-admin
npm run dev                 # http://localhost:5000
```

---

## Seeded development accounts

After `npm run db:seed`, every seeded account uses the password
**`SeedDev#2026`**:

| Role    | Email | Notes |
|---------|-------|-------|
| Student | `aarav.student@example.com` | Has registrations |
| Alumni  | `ananya.alum@example.com`  | Approved — visible in the directory |
| Alumni  | `priya.alum@example.com`   | Pending — hidden until approved |

The **"Robotics Prototype Workshop"** event is seeded at full capacity with two
waitlisted students — cancel a confirmed seat there to see the automatic
promotion fire.

> These accounts and this password exist **only** for local development. Do not
> seed a production database.

---

## Creating the first administrator

The `admin` role is deliberately **not offered on the public registration form**,
and the API rejects any attempt to self-assign it. The only supported path is
this script, which runs locally against the database.

**Interactive (recommended):**

```powershell
npm.cmd run create-admin
```

It prompts for email, name, staff ID and a password (hidden, confirmed, and
checked against the password policy). If the email already belongs to a
non-admin account, it offers to promote that account instead — without touching
the existing password.

**Non-interactive (CI / automation):**

```powershell
$env:CA_EMAIL = 'admin@college.edu'
$env:CA_PASSWORD = 'Str0ngPass!'
$env:CA_NAME = 'Portal Administrator'
npm.cmd run create-admin
# Optional: $env:CA_PROMOTE = 'yes' to auto-confirm promoting an existing user
```

Every value still passes the same validation and is hashed with bcrypt before
storage.

**Safety guards:**
- Refuses to run when `NODE_ENV=production` unless `--i-understand` is passed.
- Never overwrites an existing administrator's password silently.

---

## Running the tests

```powershell
npm.cmd test                 # unit + integration
npm.cmd run test:unit        # fast, no database needed
npm.cmd run test:integration # needs MySQL; runs serially
```

**What runs where**
- `test:unit` — pure logic: password policy, bcrypt hashing, CSV escaping,
  sanitisation, JWT signing/verification, upload type checks, validation,
  RBAC helpers. **No database required.**
- `test:integration` — drives the real HTTP API with `supertest` against the
  real database: registration validation, login success/failure, JWT role
  protection, event registration, duplicate prevention, capacity limits,
  waitlist FIFO ordering, automatic promotion, and admin-only route protection.

**If MySQL is unreachable**, integration tests **skip** with an explanatory
message rather than failing, so `npm test` still reports a clean result on a
machine without a database. See [`TESTING.md`](TESTING.md) for how isolation and
cleanup work (tests never drop tables or truncate data).

---

## How the waitlist works

Registration runs inside a database transaction with `SELECT … FOR UPDATE`
row locks, so concurrent requests cannot oversell a seat:

1. The event row is locked, serialising every registration for that event.
2. Any existing registration for that user is locked (prevents duplicates).
3. Confirmed seats are counted. If a seat is free → `confirmed`, otherwise the
   student is appended to the waitlist with the next position (FIFO).
4. On cancellation, the confirmed seat is freed and the **lowest-position**
   waitlisted student is promoted to `confirmed`, then the remaining positions
   are renumbered to close the gap.
5. Emails are sent **after** the transaction commits, so SMTP latency never
   holds a row lock.

Statuses: `confirmed`, `waitlisted`, `cancelled`.

---

## Email in development mode

If `SMTP_HOST` is empty (the default), the app runs in **dev email mode**: it
does not contact any mail server. Verification links and password-reset URLs are
printed to the **server console** instead. Copy the URL from the console into
your browser to complete the flow.

To send real mail, fill in `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`
and `MAIL_FROM` in `.env`.

---

## API summary

All endpoints are prefixed with `/api`. `🔒` requires a valid access token;
`🛡` requires the `admin` role.

| Method | Path | Notes |
|--------|------|-------|
| POST | `/api/auth/register` | Student/alumni only — role is never accepted from the body |
| POST | `/api/auth/login` | Returns access token; sets refresh cookie |
| POST | `/api/auth/refresh` | Rotates the refresh token |
| POST | `/api/auth/logout` | Revokes the refresh token |
| GET  | `/api/auth/verify-email?token=…` | Single-use hashed token |
| POST | `/api/auth/forgot-password` | |
| POST | `/api/auth/reset-password` | |
| GET  | `/api/events` | Public — search, filter, paginate |
| GET  | `/api/events/:id` | Public — detail + capacity info |
| POST | `/api/events/:id/register` | 🔒 student |
| POST | `/api/events/:id/cancel` | 🔒 student |
| GET  | `/api/events/me/registrations` | 🔒 |
| GET  | `/api/alumni/directory` | Public — approved profiles only |
| PATCH| `/api/alumni/profile` | 🔒 |
| POST | `/api/alumni/profile/picture` | 🔒 multer upload |
| GET/POST | `/api/jobs` | |
| GET/POST | `/api/connections` | 🔒 |
| GET/POST | `/api/news` | |
| GET  | `/api/admin/stats` | 🛡 |
| GET  | `/api/admin/users` | 🛡 |
| PATCH| `/api/admin/users/:id/status` | 🛡 activate / suspend |
| PATCH| `/api/admin/users/:id/role` | 🛡 guarded role changes |
| GET  | `/api/admin/alumni/pending` | 🛡 |
| POST | `/api/admin/alumni/:id/approve` | 🛡 |
| POST | `/api/admin/alumni/:id/reject` | 🛡 |
| POST | `/api/admin/events` | 🛡 |
| PUT  | `/api/admin/events/:id` | 🛡 |
| DELETE | `/api/admin/events/:id` | 🛡 soft delete |
| GET  | `/api/admin/registrations` | 🛡 |
| GET  | `/api/admin/registrations/export` | 🛡 CSV download |
| POST | `/api/admin/events/:id/notify` | 🛡 bulk notification |

Every `/api/admin/*` route is protected **server-side** by the `authorize('admin')`
middleware — hiding buttons in the browser is not protection.

---

## Troubleshooting

**`npm` is not recognised / scripts are disabled**
Use `npm.cmd` on PowerShell, or fix execution policy:
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

**`Access denied for user '…'@'…'`**
The app user in `.env` doesn't exist yet or the password is wrong. Run
`npm.cmd run db:setup`, then make `DB_USER`/`DB_PASSWORD` match what it created.
Never point the app at the root account.

**`Table '…' doesn't exist`**
Apply the schema: `npm.cmd run db:setup` (or re-run it).

**Port 5000 already in use**
Change `PORT` in `.env`, and update `CLIENT_ORIGIN` to match.

**Integration tests skip with "MySQL is not available"**
That is intentional when no database is reachable. Start MySQL and ensure
`.env` is configured — see [`TESTING.md`](TESTING.md).

**A verification email never arrives**
There is no SMTP server configured, so the link is printed in the **server
console**. That is expected in dev mode — see [Email in development mode](#email-in-development-mode).

---

## License

MIT — see [`package.json`](package.json).
