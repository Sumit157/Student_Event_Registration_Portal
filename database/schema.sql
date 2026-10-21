-- ============================================================================
-- Student Event Registration & Alumni Portal
-- Complete relational schema (MySQL 8.0+)
-- ----------------------------------------------------------------------------
-- Conventions
--   * All tables use InnoDB (transactional, supports row locking + FKs).
--   * All timestamps are stored in UTC. The application converts to the
--     browser's local timezone for display.
--   * Soft state changes (cancellation, suspension) are preferred over hard
--     deletes so that historical records and foreign keys stay intact.
--   * Every foreign key declares an explicit ON DELETE rule.
--
-- This script is IDEMPOTENT: it can be run more than once without error.
-- ============================================================================

SET NAMES utf8mb4;
SET time_zone = '+00:00';
SET FOREIGN_KEY_CHECKS = 0;

-- ----------------------------------------------------------------------------
-- 1. users  - single table for students, alumni and administrators
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name              VARCHAR(120)  NOT NULL,
  email             VARCHAR(190)  NOT NULL,
  -- bcrypt hash (cost 10). Plain-text passwords are never stored.
  password_hash     VARCHAR(255)  NOT NULL,
  role              ENUM('student','alumni','admin') NOT NULL DEFAULT 'student',
  -- College ID / roll number. Required for students and alumni.
  college_id        VARCHAR(50)   NULL,
  email_verified_at DATETIME      NULL,
  -- 0 = suspended (authenticated routes reject the account)
  is_active         TINYINT(1)    NOT NULL DEFAULT 1,
  created_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  KEY idx_users_role (role),
  KEY idx_users_is_active (is_active),
  KEY idx_users_college_id (college_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- 2. alumni_profiles - 1:1 extension of a users row with role = 'alumni'
--    approved_at is NULL until an administrator approves the alumni account,
--    which is what gates appearance in the public directory.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alumni_profiles (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         INT UNSIGNED NOT NULL,
  graduation_year SMALLINT     UNSIGNED NULL,
  degree          VARCHAR(120) NULL,
  company         VARCHAR(152) NULL,
  designation     VARCHAR(120) NULL,
  bio             TEXT         NULL,
  -- Relative path inside UPLOAD_DIR, e.g. "avatar-3-1699999999.jpg"
  profile_picture VARCHAR(255) NULL,
  approved_at     DATETIME     NULL,
  approved_by     INT UNSIGNED NULL,
  rejection_reason VARCHAR(255) NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_alumni_user (user_id),
  KEY idx_alumni_graduation (graduation_year),
  KEY idx_alumni_degree (degree),
  KEY idx_alumni_company (company),
  KEY idx_alumni_approved (approved_at),
  CONSTRAINT fk_alumni_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_alumni_approver FOREIGN KEY (approved_by)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- 3. events - created and managed by administrators
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  title       VARCHAR(200) NOT NULL,
  description TEXT         NULL,
  category    VARCHAR(60)  NOT NULL DEFAULT 'general',
  venue       VARCHAR(200) NULL,
  -- Stored in UTC.
  event_date  DATETIME     NOT NULL,
  end_date    DATETIME     NULL,
  capacity    INT UNSIGNED NOT NULL DEFAULT 0,
  image_url   VARCHAR(255) NULL,
  is_active   TINYINT(1)   NOT NULL DEFAULT 1,
  created_by  INT UNSIGNED NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_events_date (event_date),
  KEY idx_events_category (category),
  KEY idx_events_active (is_active),
  CONSTRAINT fk_events_creator FOREIGN KEY (created_by)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- 4. event_registrations
--    status: confirmed | waitlisted | cancelled
--    The UNIQUE key on (event_id, user_id) is the hard guarantee that a
--    student can never hold two registrations for the same event. A student
--    who cancels and returns re-activates the SAME row.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_registrations (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_id         INT UNSIGNED NOT NULL,
  user_id          INT UNSIGNED NOT NULL,
  status           ENUM('confirmed','waitlisted','cancelled') NOT NULL DEFAULT 'confirmed',
  -- Sequential rank among waitlisted users (1 = next in line). NULL when confirmed.
  waitlist_position INT UNSIGNED NULL,
  registered_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cancelled_at     DATETIME NULL,
  -- Denormalised snapshot used for notification emails at event time.
  notified_at      DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_registration (event_id, user_id),
  KEY idx_reg_event_status (event_id, status),
  KEY idx_reg_user (user_id),
  KEY idx_reg_waitlist_order (event_id, status, registered_at),
  CONSTRAINT fk_reg_event FOREIGN KEY (event_id)
    REFERENCES events (id) ON DELETE CASCADE,
  CONSTRAINT fk_reg_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- 5. job_posts - created by approved alumni
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_posts (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  poster_id   INT UNSIGNED NOT NULL,
  title       VARCHAR(200) NOT NULL,
  company     VARCHAR(152) NOT NULL,
  location    VARCHAR(152) NULL,
  description TEXT         NULL,
  job_type    ENUM('full_time','part_time','internship','contract') NOT NULL DEFAULT 'full_time',
  -- Validated absolute http(s) URL.
  apply_url   VARCHAR(500) NOT NULL,
  deadline    DATE         NULL,
  is_active   TINYINT(1)   NOT NULL DEFAULT 1,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_jobs_company (company),
  KEY idx_jobs_type (job_type),
  KEY idx_jobs_deadline (deadline),
  KEY idx_jobs_active (is_active),
  KEY idx_jobs_poster (poster_id),
  CONSTRAINT fk_jobs_poster FOREIGN KEY (poster_id)
    REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- 6. connections - alumni-to-alumni networking
--    requester_id initiates, addressee_id accepts or rejects.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connections (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  requester_id INT UNSIGNED NOT NULL,
  addressee_id INT UNSIGNED NOT NULL,
  status       ENUM('pending','accepted','rejected') NOT NULL DEFAULT 'pending',
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- Prevents the exact same directed request being sent twice.
  UNIQUE KEY uq_connection (requester_id, addressee_id),
  KEY idx_conn_addressee_status (addressee_id, status),
  KEY idx_conn_requester (requester_id),
  CONSTRAINT fk_conn_requester FOREIGN KEY (requester_id)
    REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_conn_addressee FOREIGN KEY (addressee_id)
    REFERENCES users (id) ON DELETE CASCADE,
  -- A user cannot connect to themselves.
  CONSTRAINT chk_conn_self CHECK (requester_id <> addressee_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- 7. news - college news and announcements
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS news (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  title      VARCHAR(200) NOT NULL,
  content    TEXT         NOT NULL,
  author_id  INT UNSIGNED NULL,
  is_active  TINYINT(1)   NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_news_created (created_at),
  CONSTRAINT fk_news_author FOREIGN KEY (author_id)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- 8. comments - paginated discussion attached to a news item
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS comments (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  news_id    INT UNSIGNED NOT NULL,
  user_id    INT UNSIGNED NOT NULL,
  content    TEXT         NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_comments_news (news_id, created_at),
  CONSTRAINT fk_comments_news FOREIGN KEY (news_id)
    REFERENCES news (id) ON DELETE CASCADE,
  CONSTRAINT fk_comments_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- 9. email_verification_tokens
--    Only the SHA-256 hash of the token is stored, so a database leak does not
--    hand out live verification links. Single use + hard expiry.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    INT UNSIGNED NOT NULL,
  token_hash CHAR(64)     NOT NULL,
  expires_at DATETIME     NOT NULL,
  used_at    DATETIME     NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_evt_hash (token_hash),
  KEY idx_evt_user (user_id),
  CONSTRAINT fk_evt_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- 10. password_reset_tokens - identical single-use, expiring design
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    INT UNSIGNED NOT NULL,
  token_hash CHAR(64)     NOT NULL,
  expires_at DATETIME     NOT NULL,
  used_at    DATETIME     NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_prt_hash (token_hash),
  KEY idx_prt_user (user_id),
  CONSTRAINT fk_prt_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- 11. refresh_tokens
--    Opaque random tokens. Only the SHA-256 hash is stored. Each token can be
--    rotated exactly once (replaced_by_id) and revoked server-side, which is
--    what makes refresh-token rotation theft resistant.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id        INT UNSIGNED NOT NULL,
  token_hash     CHAR(64)     NOT NULL,
  expires_at     DATETIME     NOT NULL,
  revoked_at     DATETIME     NULL,
  replaced_by_id INT UNSIGNED NULL,
  user_agent     VARCHAR(255) NULL,
  ip_address     VARCHAR(45)  NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_rt_hash (token_hash),
  KEY idx_rt_user (user_id),
  KEY idx_rt_expires (expires_at),
  CONSTRAINT fk_rt_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_rt_replaced FOREIGN KEY (replaced_by_id)
    REFERENCES refresh_tokens (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;

-- ============================================================================
-- Reference view used by the admin dashboard statistics endpoint.
-- Kept as a view so the reporting queries stay in one place.
-- ============================================================================
CREATE OR REPLACE VIEW vw_registration_stats AS
SELECT
  e.id            AS event_id,
  e.title         AS event_title,
  e.capacity      AS capacity,
  e.event_date    AS event_date,
  SUM(r.status = 'confirmed')  AS confirmed_count,
  SUM(r.status = 'waitlisted') AS waitlisted_count,
  SUM(r.status = 'cancelled')  AS cancelled_count,
  GREATEST(e.capacity - SUM(r.status = 'confirmed'), 0) AS seats_remaining
FROM events e
LEFT JOIN event_registrations r ON r.event_id = e.id
GROUP BY e.id, e.title, e.capacity, e.event_date;
