-- AMRUT Peth Direct Market CMS — initial schema.
-- Applied once by migrations/migrate.js and recorded in schema_migrations.
--
-- Conventions
--   * Every content table soft-deletes through deleted_at; nothing is removed
--     by normal admin operations, and no foreign key cascades a hard delete.
--   * Unique business keys (emails, slugs, codes) are enforced with partial
--     unique indexes over live rows only, so a soft-deleted record never blocks
--     re-creating the same value.
--   * Bilingual text is stored as <field>_mr (Marathi, primary) and <field>_en.

-- ====================================================================
-- ADMIN AUTH
-- ====================================================================

CREATE TABLE admin_users (
  id              SERIAL PRIMARY KEY,
  email           TEXT NOT NULL,
  name            TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'admin'
                  CHECK (role IN ('superadmin', 'admin', 'editor')),
  avatar_url      TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  last_login_at   TIMESTAMPTZ,
  deleted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX admin_users_email_live ON admin_users (LOWER(email)) WHERE deleted_at IS NULL;

CREATE TABLE admin_sessions (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  user_id     INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  ip_address  TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX admin_sessions_user ON admin_sessions (user_id);

-- ====================================================================
-- MEDIA LIBRARY
-- ====================================================================

CREATE TABLE media_assets (
  id             SERIAL PRIMARY KEY,
  filename       TEXT NOT NULL UNIQUE,
  original_name  TEXT NOT NULL,
  mime_type      TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL DEFAULT 0,
  url            TEXT NOT NULL,
  alt_text       TEXT NOT NULL DEFAULT '',
  uploaded_by    INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  deleted_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX media_assets_live ON media_assets (created_at DESC) WHERE deleted_at IS NULL;

-- ====================================================================
-- PAGE SECTIONS (single-record blocks with draft / published copies)
-- key: settings | contact | hero | about | highlights | participate | register | footer
-- ====================================================================

CREATE TABLE page_sections (
  key           TEXT PRIMARY KEY,
  draft         JSONB NOT NULL DEFAULT '{}'::JSONB,
  published     JSONB NOT NULL DEFAULT '{}'::JSONB,
  published_at  TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by    INTEGER REFERENCES admin_users(id) ON DELETE SET NULL
);

-- ====================================================================
-- CONTENT COLLECTIONS (ordered, publishable, soft-deletable lists)
-- ====================================================================

-- Header / footer navigation to the home-page sections.
CREATE TABLE nav_items (
  id              SERIAL PRIMARY KEY,
  label_mr        TEXT NOT NULL,
  label_en        TEXT NOT NULL DEFAULT '',
  section         TEXT NOT NULL,
  show_in_header  BOOLEAN NOT NULL DEFAULT TRUE,
  show_in_footer  BOOLEAN NOT NULL DEFAULT TRUE,
  display_order   INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'draft')),
  created_by      INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  updated_by      INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  deleted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hero "facts" strip (Organised by / Open to / Format / Middlemen).
CREATE TABLE hero_facts (
  id             SERIAL PRIMARY KEY,
  label_mr       TEXT NOT NULL,
  label_en       TEXT NOT NULL DEFAULT '',
  value_mr       TEXT NOT NULL,
  value_en       TEXT NOT NULL DEFAULT '',
  display_order  INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'draft')),
  created_by     INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  updated_by     INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  deleted_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hero quick-link cards.
CREATE TABLE quick_links (
  id             SERIAL PRIMARY KEY,
  title_mr       TEXT NOT NULL,
  title_en       TEXT NOT NULL DEFAULT '',
  desc_mr        TEXT NOT NULL DEFAULT '',
  desc_en        TEXT NOT NULL DEFAULT '',
  icon           TEXT NOT NULL DEFAULT 'info',
  section        TEXT NOT NULL,
  display_order  INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'draft')),
  created_by     INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  updated_by     INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  deleted_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Product categories ("What you'll find").
CREATE TABLE categories (
  id              SERIAL PRIMARY KEY,
  name_mr         TEXT NOT NULL,
  name_en         TEXT NOT NULL DEFAULT '',
  slug            TEXT NOT NULL,
  description_mr  TEXT NOT NULL DEFAULT '',
  description_en  TEXT NOT NULL DEFAULT '',
  display_order   INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'draft')),
  created_by      INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  updated_by      INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  deleted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX categories_slug_live ON categories (slug) WHERE deleted_at IS NULL;

-- Market highlight cards ("Why AMRUT Peth").
CREATE TABLE highlights (
  id             SERIAL PRIMARY KEY,
  title_mr       TEXT NOT NULL,
  title_en       TEXT NOT NULL DEFAULT '',
  desc_mr        TEXT NOT NULL DEFAULT '',
  desc_en        TEXT NOT NULL DEFAULT '',
  icon           TEXT NOT NULL DEFAULT 'sparkle',
  display_order  INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'draft')),
  created_by     INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  updated_by     INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  deleted_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- "Who can apply" groups in the participation section.
CREATE TABLE eligibility_groups (
  id             SERIAL PRIMARY KEY,
  name_mr        TEXT NOT NULL,
  name_en        TEXT NOT NULL DEFAULT '',
  display_order  INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'draft')),
  created_by     INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  updated_by     INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  deleted_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Participation process steps.
CREATE TABLE participation_steps (
  id             SERIAL PRIMARY KEY,
  title_mr       TEXT NOT NULL,
  title_en       TEXT NOT NULL DEFAULT '',
  desc_mr        TEXT NOT NULL DEFAULT '',
  desc_en        TEXT NOT NULL DEFAULT '',
  icon           TEXT NOT NULL DEFAULT 'send',
  display_order  INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'draft')),
  created_by     INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  updated_by     INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  deleted_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Subjects offered in the enquiry form's dropdown.
CREATE TABLE enquiry_subjects (
  id             SERIAL PRIMARY KEY,
  code           TEXT NOT NULL,
  label_mr       TEXT NOT NULL,
  label_en       TEXT NOT NULL DEFAULT '',
  display_order  INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'draft')),
  created_by     INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  updated_by     INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  deleted_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX enquiry_subjects_code_live ON enquiry_subjects (code) WHERE deleted_at IS NULL;

-- Official website and social media links (footer "Official" column).
CREATE TABLE social_links (
  id             SERIAL PRIMARY KEY,
  label          TEXT NOT NULL,
  url            TEXT NOT NULL,
  icon           TEXT NOT NULL DEFAULT 'globe',
  display_order  INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'draft')),
  created_by     INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  updated_by     INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  deleted_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Public listing index for every collection: live + published, in order.
CREATE INDEX nav_items_public           ON nav_items (display_order)           WHERE deleted_at IS NULL AND status = 'published';
CREATE INDEX hero_facts_public          ON hero_facts (display_order)          WHERE deleted_at IS NULL AND status = 'published';
CREATE INDEX quick_links_public         ON quick_links (display_order)         WHERE deleted_at IS NULL AND status = 'published';
CREATE INDEX categories_public          ON categories (display_order)          WHERE deleted_at IS NULL AND status = 'published';
CREATE INDEX highlights_public          ON highlights (display_order)          WHERE deleted_at IS NULL AND status = 'published';
CREATE INDEX eligibility_groups_public  ON eligibility_groups (display_order)  WHERE deleted_at IS NULL AND status = 'published';
CREATE INDEX participation_steps_public ON participation_steps (display_order) WHERE deleted_at IS NULL AND status = 'published';
CREATE INDEX enquiry_subjects_public    ON enquiry_subjects (display_order)    WHERE deleted_at IS NULL AND status = 'published';
CREATE INDEX social_links_public        ON social_links (display_order)        WHERE deleted_at IS NULL AND status = 'published';

-- ====================================================================
-- ENQUIRIES (registration / contact form submissions)
-- ====================================================================

CREATE TABLE enquiries (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  email          TEXT NOT NULL,
  phone          TEXT NOT NULL DEFAULT '',
  subject_code   TEXT NOT NULL,
  subject_label  TEXT NOT NULL DEFAULT '',   -- label at submission time, kept if the subject changes later
  message        TEXT NOT NULL,
  consent        BOOLEAN NOT NULL DEFAULT FALSE,
  language       TEXT NOT NULL DEFAULT 'mr' CHECK (language IN ('mr', 'en')),
  status         TEXT NOT NULL DEFAULT 'new'
                 CHECK (status IN ('new', 'reviewed', 'actioned', 'archived')),
  admin_notes    TEXT NOT NULL DEFAULT '',
  ip_address     TEXT,
  user_agent     TEXT,
  reviewed_by    INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  reviewed_at    TIMESTAMPTZ,
  deleted_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX enquiries_live_created ON enquiries (created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX enquiries_status ON enquiries (status) WHERE deleted_at IS NULL;

-- ====================================================================
-- AUDIT LOG
-- ====================================================================

CREATE TABLE activity_logs (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  user_name   TEXT NOT NULL DEFAULT '',
  action      TEXT NOT NULL,          -- create | update | delete | restore | status | publish | discard | login | upload ...
  entity      TEXT NOT NULL,          -- table / module name
  entity_id   TEXT,
  summary     TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX activity_logs_created ON activity_logs (created_at DESC);
