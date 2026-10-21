'use strict';

/**
 * scripts/seed.js  (run with: npm run db:seed)
 *
 * DEVELOPMENT FIXTURES ONLY. Creates believable sample data so every feature
 * can be demonstrated without hand-entering dozens of records.
 *
 * Safety properties:
 *   * Idempotent - it checks for each record first and skips what exists, so
 *     running it twice never duplicates data or breaks unique constraints.
 *   * It NEVER modifies or deletes data it did not create. Every seeded row
 *     uses an obvious "@example.com" address or a clearly sample title.
 *   * It does not create or alter administrator accounts (use npm run
 *     create-admin for that).
 *   * All seed passwords are the same well-known development value and are
 *     printed at the end. They are explicitly NOT usable in production.
 *
 * What it creates:
 *   students   5   (verified)
 *   alumni     6   (4 approved + 2 pending, to show the approval queue)
 *   events    14   (including one deliberately FULL event for the waitlist demo,
 *                   which is why 14 > 10 items/page also exercises pagination)
 *   news       3   (with sample comments)
 *   jobs       3   (from approved alumni)
 *   connections (2 accepted, 1 pending)
 */

require('dotenv').config();

const bcrypt = require('bcryptjs');

const { env } = require('../config/env');
const { getPool, closePool, testConnection } = require('../config/db');
const { checkPassword } = require('../utils/passwordPolicy');

const BCRYPT_ROUNDS = 10;
const SEED_PASSWORD = 'SeedDev#2026'; // matches the policy: 8+, upper, lower, digit

function daysFromNow(days, hour = 10, minute = 0) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function log(message) { console.log(`[seed] ${message}`); }

/** Find a user by email, or insert them (verified) and return the id. */
async function ensureUser(pool, { name, email, role, collegeId, verified = true, passwordHash }) {
  const [existing] = await pool.execute(`SELECT id FROM users WHERE email = ?`, [email]);
  if (existing.length > 0) return { id: existing[0].id, created: false };

  const [result] = await pool.execute(
    `INSERT INTO users (name, email, password_hash, role, college_id, email_verified_at, is_active)
     VALUES (?, ?, ?, ?, ?, ${verified ? 'CURRENT_TIMESTAMP' : 'NULL'}, 1)`,
    [name, email, passwordHash, role, collegeId]
  );
  return { id: result.insertId, created: true };
}

async function ensureAlumniProfile(pool, userId, details) {
  const [existing] = await pool.execute(`SELECT id FROM alumni_profiles WHERE user_id = ?`, [userId]);
  if (existing.length > 0) return { created: false };

  await pool.execute(
    `INSERT INTO alumni_profiles (user_id, graduation_year, degree, company, designation, bio, approved_at, approved_by)
     VALUES (?, ?, ?, ?, ?, ?, ${details.approved ? 'CURRENT_TIMESTAMP' : 'NULL'}, ${details.approved ? '(SELECT id FROM users WHERE role = \'admin\' LIMIT 1)' : 'NULL'})`,
    [
      userId,
      details.graduationYear || null,
      details.degree || null,
      details.company || null,
      details.designation || null,
      details.bio || null,
    ]
  );
  return { created: true };
}

async function ensureEvent(pool, event) {
  const [existing] = await pool.execute(`SELECT id FROM events WHERE title = ?`, [event.title]);
  if (existing.length > 0) return { id: existing[0].id, created: false };

  const [result] = await pool.execute(
    `INSERT INTO events (title, description, category, venue, event_date, end_date, capacity, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT id FROM users WHERE role = 'admin' LIMIT 1))`,
    [event.title, event.description, event.category, event.venue, event.eventDate, event.endDate || null, event.capacity]
  );
  return { id: result.insertId, created: true };
}

async function main() {
  console.log('\n==========================================================');
  console.log(' Campus Portal - development seed');
  console.log('==========================================================\n');

  if (env.isProduction) {
    console.error('[seed] Refusing to seed when NODE_ENV=production.\n');
    process.exit(1);
  }

  const policy = checkPassword(SEED_PASSWORD);
  if (!policy.valid) {
    console.error('[seed] Seed password no longer satisfies the policy - aborting.');
    process.exit(1);
  }

  try {
    const status = await testConnection();
    log(`Connected to ${status.database} at ${status.host}:${status.port}`);
  } catch (error) {
    console.error(`[seed] Cannot reach the database: ${error.code || error.message}`);
    console.error('[seed] Run "npm run db:setup" first.\n');
    process.exit(1);
  }

  const pool = getPool();
  const stats = { users: 0, alumni: 0, events: 0, news: 0, jobs: 0, registrations: 0 };
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, BCRYPT_ROUNDS);

  // ---------------------------------------------------------------- students
  const students = [
    { name: 'Aarav Mehta', email: 'aarav.student@example.com', collegeId: 'CS2024-001' },
    { name: 'Diya Nair', email: 'diya.student@example.com', collegeId: 'EC2024-014' },
    { name: 'Rohan Gupta', email: 'rohan.student@example.com', collegeId: 'ME2023-072' },
    { name: 'Sara Khan', email: 'sara.student@example.com', collegeId: 'IT2025-006' },
    { name: 'Vikram Iyer', email: 'vikram.student@example.com', collegeId: 'CS2022-045' },
  ];
  const studentIds = {};
  for (const s of students) {
    const row = await ensureUser(pool, { ...s, role: 'student', passwordHash });
    studentIds[s.email] = row.id;
    if (row.created) stats.users += 1;
  }
  log(`Students ready (${students.length})`);

  // ------------------------------------------------------------------ alumni
  const alumni = [
    {
      name: 'Ananya Sharma', email: 'ananya.alum@example.com', collegeId: 'CS2015-011', approved: true,
      graduationYear: 2015, degree: 'B.Tech Computer Science', company: 'Google', designation: 'Senior Software Engineer',
      bio: 'Back to help with interview prep and open source mentoring.',
    },
    {
      name: 'Karthik Rao', email: 'karthik.alum@example.com', collegeId: 'EC2012-033', approved: true,
      graduationYear: 2012, degree: 'B.Tech Electronics', company: 'Intel', designation: 'Hardware Architect',
      bio: 'VLSI and embedded systems. Happy to review resumes.',
    },
    {
      name: 'Meera Joshi', email: 'meera.alum@example.com', collegeId: 'CS2018-057', approved: true,
      graduationYear: 2018, degree: 'M.Tech Computer Science', company: 'Infosys', designation: 'Data Science Lead',
      bio: 'Building analytics teams. I run a monthly data hackathon.',
    },
    {
      name: 'Daniel Fernandes', email: 'daniel.alum@example.com', collegeId: 'ME2010-021', approved: true,
      graduationYear: 2010, degree: 'B.Tech Mechanical', company: 'L&T', designation: 'Project Manager',
      bio: 'Manufacturing and operations. Open to internship referrals.',
    },
    {
      name: 'Priya Menon', email: 'priya.alum@example.com', collegeId: 'IT2019-088', approved: false,
      graduationYear: 2019, degree: 'B.Tech Information Technology', company: 'Zoho', designation: 'Product Analyst',
      bio: 'Product and UX. Would love to give guest talks.',
    },
    {
      name: 'Rahul Verma', email: 'rahul.alum@example.com', collegeId: 'CS2021-104', approved: false,
      graduationYear: 2021, degree: 'B.Tech Computer Science', company: 'Startup Labs', designation: 'Founding Engineer',
      bio: 'Early stage startup life. Looking to hire interns.',
    },
  ];
  const alumniIds = {};
  for (const a of alumni) {
    const row = await ensureUser(pool, {
      name: a.name, email: a.email, role: 'alumni', collegeId: a.collegeId, passwordHash,
    });
    alumniIds[a.email] = row.id;
    if (row.created) stats.users += 1;

    const profile = await ensureAlumniProfile(pool, row.id, a);
    if (profile.created) stats.alumni += 1;
  }
  log(`Alumni ready (${alumni.length}: ${alumni.filter((a) => a.approved).length} approved, ${alumni.filter((a) => !a.approved).length} pending)`);

  // ------------------------------------------------------------------ events
  const events = [
    // Capacity 2 - deliberately tiny so the waitlist can be demonstrated.
    { title: 'Robotics Prototype Workshop', category: 'workshop', venue: 'Innovation Lab', eventDate: daysFromNow(3, 9, 30), capacity: 2, description: 'Build and program a line-following robot. Materials provided; bring your laptop.' },
    { title: 'Annual Tech Symposium 2026', category: 'career', venue: 'Main Auditorium', eventDate: daysFromNow(10, 9, 0), endDate: daysFromNow(10, 17, 0), capacity: 250, description: 'A full day of talks, demos and a placement drive with 20+ participating companies.' },
    { title: 'Inter-College Football Finals', category: 'sports', venue: 'Central Ground', eventDate: daysFromNow(5, 16, 0), capacity: 400, description: 'Cheer for the home side in the championship decider.' },
    { title: 'Cultural Night: Rhythm & Roots', category: 'cultural', venue: 'Open Air Theatre', eventDate: daysFromNow(8, 18, 30), capacity: 300, description: 'Music, dance and drama performances by student clubs.' },
    { title: 'Resume & Interview Clinic', category: 'career', venue: 'Seminar Hall B', eventDate: daysFromNow(6, 14, 0), capacity: 45, description: 'Alumni review your resume one-to-one and run mock interviews.' },
    { title: 'Web Development Bootcamp', category: 'workshop', venue: 'Computer Lab 3', eventDate: daysFromNow(12, 10, 0), endDate: daysFromNow(12, 16, 0), capacity: 40, description: 'Hands-on HTML, CSS and JavaScript in a single day.' },
    { title: 'Yoga & Wellness Morning', category: 'sports', venue: 'Sports Complex', eventDate: daysFromNow(2, 7, 0), capacity: 60, description: 'Start the day right with a guided session open to everyone.' },
    { title: 'Startup Founders Meetup', category: 'career', venue: 'Innovation Lab', eventDate: daysFromNow(15, 17, 0), capacity: 80, description: 'Founders share what actually worked - and what did not.' },
    { title: 'Photography Walk', category: 'cultural', venue: 'Main Gate', eventDate: daysFromNow(9, 16, 30), capacity: 25, description: 'Golden hour campus walk. Bring any camera, including a phone.' },
    { title: 'Data Structures Refresher', category: 'workshop', venue: 'Computer Lab 1', eventDate: daysFromNow(4, 15, 0), capacity: 50, description: 'Crack the basics before placement season starts.' },
    { title: 'Alumni Homecoming Day', category: 'general', venue: 'Main Auditorium', eventDate: daysFromNow(20, 11, 0), capacity: 350, description: 'Graduates return to campus for a day of panels and reunions.' },
    { title: 'Debate: Technology & Society', category: 'general', venue: 'Seminar Hall A', eventDate: daysFromNow(7, 11, 0), capacity: 70, description: 'Motion: "Social media has done more harm than good."' },
    { title: 'Cricket Practice Match', category: 'sports', venue: 'Lower Ground', eventDate: daysFromNow(1, 15, 30), capacity: 30, description: 'Friendly fixture ahead of the inter-college tournament.' },
    { title: 'Farewell Batch 2026', category: 'cultural', venue: 'Main Auditorium', eventDate: daysFromNow(25, 17, 30), capacity: 400, description: 'The graduating batch signs off with performances and memories.' },
  ];

  const eventIds = {};
  for (const e of events) {
    const row = await ensureEvent(pool, e);
    eventIds[e.title] = row.id;
    if (row.created) stats.events += 1;
  }
  log(`Events ready (${events.length})`);

  // ------------------------------------------- registrations (some waitlisted)
  // The Robotics workshop has capacity 2: first two students confirm, the next
  // two are waitlisted, which demonstrates the full lifecycle immediately.
  async function register(eventTitle, studentEmail, status, position = null) {
    const eventId = eventIds[eventTitle];
    const userId = studentIds[studentEmail];
    if (!eventId || !userId) return;

    const [existing] = await pool.execute(
      `SELECT id FROM event_registrations WHERE event_id = ? AND user_id = ?`, [eventId, userId]
    );
    if (existing.length > 0) return;

    await pool.execute(
      `INSERT INTO event_registrations (event_id, user_id, status, waitlist_position, registered_at, cancelled_at)
       VALUES (?, ?, ?, ?, DATE_SUB(NOW(), INTERVAL 2 DAY), ${status === 'cancelled' ? 'DATE_SUB(NOW(), INTERVAL 1 DAY)' : 'NULL'})`,
      [eventId, userId, status, status === 'waitlisted' ? position : null]
    );
    stats.registrations += 1;
  }

  // --- Robotics workshop (capacity 2) - the waitlist showcase ---
  await register('Robotics Prototype Workshop', students[0].email, 'confirmed');
  await register('Robotics Prototype Workshop', students[1].email, 'confirmed');
  await register('Robotics Prototype Workshop', students[2].email, 'waitlisted', 1);
  await register('Robotics Prototype Workshop', students[3].email, 'waitlisted', 2);

  // --- Other events: a realistic spread ---
  await register('Annual Tech Symposium 2026', students[0].email, 'confirmed');
  await register('Annual Tech Symposium 2026', students[1].email, 'confirmed');
  await register('Annual Tech Symposium 2026', students[2].email, 'confirmed');
  await register('Annual Tech Symposium 2026', students[3].email, 'confirmed');
  await register('Annual Tech Symposium 2026', students[4].email, 'confirmed');
  await register('Resume & Interview Clinic', students[1].email, 'confirmed');
  await register('Resume & Interview Clinic', students[4].email, 'confirmed');
  await register('Web Development Bootcamp', students[0].email, 'confirmed');
  await register('Web Development Bootcamp', students[3].email, 'confirmed');
  await register('Data Structures Refresher', students[2].email, 'confirmed');
  await register('Yoga & Wellness Morning', students[4].email, 'confirmed');
  await register('Cricket Practice Match', students[0].email, 'cancelled');
  await register('Debate: Technology & Society', students[1].email, 'confirmed');
  await register('Cultural Night: Rhythm & Roots', students[3].email, 'confirmed');
  log(`Registrations ready (${stats.registrations})`);

  // -------------------------------------------------------------------- news
  const newsItems = [
    {
      title: 'Semester registration opens on Monday',
      content: 'Course registration for the next semester opens Monday at 9:00 am and closes on Friday. Students must clear any outstanding dues beforehand. Advisers will be available in the admin block throughout the week if you need help choosing electives.',
      comments: [
        { email: students[0].email, content: 'Is the lab fee included in the dues, or is that separate?' },
        { email: students[1].email, content: 'Last semester the portal was very slow on day one - worth trying early.' },
      ],
    },
    {
      title: 'Placement drive: 20 companies visiting campus',
      content: 'The placement cell has confirmed participation from 20 companies across software, hardware and core branches. Register through your department coordinator by the end of this week. Students with backlogs are eligible for a limited set of companies - check the detailed eligibility matrix before applying.',
      comments: [
        { email: students[4].email, content: 'Will there be a pre-placement talk session before the tests?' },
      ],
    },
    {
      title: 'Library extends hours during exam week',
      content: 'The central library will stay open until midnight throughout the examination period. The reading hall on the second floor is now open 24 hours for group study. Please carry your college ID card for entry after 10 pm.',
      comments: [],
    },
  ];

  for (const item of newsItems) {
    const [existing] = await pool.execute(`SELECT id FROM news WHERE title = ?`, [item.title]);
    let newsId;
    if (existing.length === 0) {
      const [result] = await pool.execute(
        `INSERT INTO news (title, content, author_id) VALUES (?, ?, (SELECT id FROM users WHERE role = 'admin' LIMIT 1))`,
        [item.title, item.content]
      );
      newsId = result.insertId;
      stats.news += 1;
    } else {
      newsId = existing[0].id;
    }

    for (const comment of item.comments) {
      const userId = studentIds[comment.email];
      if (!userId) continue;
      const [dup] = await pool.execute(
        `SELECT id FROM comments WHERE news_id = ? AND user_id = ? AND content = ?`,
        [newsId, userId, comment.content]
      );
      if (dup.length === 0) {
        await pool.execute(`INSERT INTO comments (news_id, user_id, content) VALUES (?, ?, ?)`, [newsId, userId, comment.content]);
      }
    }
  }
  log(`News ready (${newsItems.length} items with sample comments)`);

  // -------------------------------------------------------------------- jobs
  const jobs = [
    { poster: alumni[0].email, title: 'Software Engineering Intern (Summer 2026)', company: 'Google', location: 'Bengaluru', jobType: 'internship', applyUrl: 'https://careers.google.com/students/', deadline: daysFromNow(21).slice(0, 10), description: 'Work on real production systems alongside a mentor. Open to penultimate-year students of any engineering branch with strong fundamentals.' },
    { poster: alumni[1].email, title: 'Graduate Hardware Engineer', company: 'Intel', location: 'Hyderabad', jobType: 'full_time', applyUrl: 'https://www.intel.com/content/www/us/en/jobs/jobs-at-intel.html', deadline: daysFromNow(30).slice(0, 10), description: 'Verification and design roles for recent graduates in ECE and allied branches.' },
    { poster: alumni[2].email, title: 'Data Science Intern', company: 'Infosys', location: 'Pune / Remote', jobType: 'internship', applyUrl: 'https://careers.infosys.com/', deadline: null, description: 'Six month internship building dashboards and forecasting models. Python and SQL required.' },
  ];

  for (const job of jobs) {
    const posterId = alumniIds[job.poster];
    if (!posterId) continue;
    const [existing] = await pool.execute(`SELECT id FROM job_posts WHERE title = ? AND poster_id = ?`, [job.title, posterId]);
    if (existing.length === 0) {
      await pool.execute(
        `INSERT INTO job_posts (poster_id, title, company, location, description, job_type, apply_url, deadline)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [posterId, job.title, job.company, job.location, job.description, job.jobType, job.applyUrl, job.deadline]
      );
      stats.jobs += 1;
    }
  }
  log(`Jobs ready (${jobs.length})`);

  // ------------------------------------------------- connections (accepted + pending)
  async function ensureConnection(requesterEmail, addresseeEmail, status) {
    const requesterId = alumniIds[requesterEmail];
    const addresseeId = alumniIds[addresseeEmail];
    if (!requesterId || !addresseeId) return;
    const [existing] = await pool.execute(
      `SELECT id FROM connections WHERE requester_id = ? AND addressee_id = ?`,
      [requesterId, addresseeId]
    );
    if (existing.length === 0) {
      await pool.execute(
        `INSERT INTO connections (requester_id, addressee_id, status) VALUES (?, ?, ?)`,
        [requesterId, addresseeId, status]
      );
    }
  }

  await ensureConnection(alumni[0].email, alumni[1].email, 'accepted');
  await ensureConnection(alumni[2].email, alumni[0].email, 'accepted');
  await ensureConnection(alumni[3].email, alumni[1].email, 'pending');
  log('Connections ready (2 accepted, 1 pending)');

  // ------------------------------------------------------------------ report
  console.log('\n==========================================================');
  console.log(' Seed complete');
  console.log('==========================================================');
  console.log(`  New users          : ${stats.users}`);
  console.log(`  New alumni profiles: ${stats.alumni}`);
  console.log(`  New events         : ${stats.events}`);
  console.log(`  New registrations  : ${stats.registrations}`);
  console.log(`  News / jobs        : ${stats.news} / ${stats.jobs}`);
  console.log('\n  Development sign-in details (DEVELOPMENT ONLY):');
  console.log(`    Password for every seeded account: ${SEED_PASSWORD}`);
  console.log('\n  Sample student : aarav.student@example.com');
  console.log('  Sample alumni  : ananya.alum@example.com   (approved)');
  console.log('  Pending alumni : priya.alum@example.com    (awaiting approval)');
  console.log('\n  The "Robotics Prototype Workshop" is FULL (capacity 2),');
  console.log('  with 2 students waitlisted - use it to demo promotion.');
  console.log('==========================================================\n');

  await closePool();
}

main().catch(async (error) => {
  console.error(`\n[seed] Failed: ${error && error.message ? error.message : error}`);
  if (error && error.stack) console.error(error.stack);
  try { await closePool(); } catch (_) { /* ignore */ }
  process.exit(1);
});
