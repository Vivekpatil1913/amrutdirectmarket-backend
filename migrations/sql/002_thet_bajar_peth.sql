-- Thet Bajar Peth PRD: districts, events with stall quotas, vendor
-- registrations (OTP-verified, Aadhaar encrypted), sponsors with a super-admin
-- approval workflow, event media, dynamic form definitions, success stories,
-- and the district_manager role.
--
-- Same conventions as 001: soft delete through deleted_at, partial unique
-- indexes over live rows, bilingual <field>_mr / <field>_en columns.

-- ====================================================================
-- DISTRICTS (reference data; the GIS map plots lat / lng)
-- ====================================================================

CREATE TABLE districts (
  id          SERIAL PRIMARY KEY,
  code        TEXT NOT NULL,
  name_mr     TEXT NOT NULL,
  name_en     TEXT NOT NULL,
  lat         NUMERIC(8, 5) NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng         NUMERIC(8, 5) NOT NULL CHECK (lng BETWEEN -180 AND 180),
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  deleted_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX districts_code_live ON districts (code) WHERE deleted_at IS NULL;

INSERT INTO districts (code, name_mr, name_en, lat, lng) VALUES
  ('ahilyanagar', 'अहिल्यानगर', 'Ahilyanagar', 19.09520, 74.74960),
  ('akola', 'अकोला', 'Akola', 20.70020, 77.00820),
  ('amravati', 'अमरावती', 'Amravati', 20.93740, 77.77960),
  ('beed', 'बीड', 'Beed', 18.98910, 75.76010),
  ('bhandara', 'भंडारा', 'Bhandara', 21.16690, 79.65000),
  ('buldhana', 'बुलढाणा', 'Buldhana', 20.53130, 76.18110),
  ('chandrapur', 'चंद्रपूर', 'Chandrapur', 19.96150, 79.29610),
  ('chh-sambhajinagar', 'छत्रपती संभाजीनगर', 'Chhatrapati Sambhajinagar', 19.87620, 75.34330),
  ('dharashiv', 'धाराशिव', 'Dharashiv', 18.18600, 76.04190),
  ('dhule', 'धुळे', 'Dhule', 20.90420, 74.77490),
  ('gadchiroli', 'गडचिरोली', 'Gadchiroli', 20.18490, 79.99480),
  ('gondia', 'गोंदिया', 'Gondia', 21.46020, 80.19200),
  ('hingoli', 'हिंगोली', 'Hingoli', 19.71730, 77.14940),
  ('jalgaon', 'जळगाव', 'Jalgaon', 21.00770, 75.56260),
  ('jalna', 'जालना', 'Jalna', 19.84100, 75.88640),
  ('kolhapur', 'कोल्हापूर', 'Kolhapur', 16.70500, 74.24330),
  ('latur', 'लातूर', 'Latur', 18.40880, 76.56040),
  ('mumbai-city', 'मुंबई शहर', 'Mumbai City', 18.93880, 72.83540),
  ('mumbai-suburban', 'मुंबई उपनगर', 'Mumbai Suburban', 19.12100, 72.86500),
  ('nagpur', 'नागपूर', 'Nagpur', 21.14580, 79.08820),
  ('nanded', 'नांदेड', 'Nanded', 19.13830, 77.32100),
  ('nandurbar', 'नंदुरबार', 'Nandurbar', 21.36950, 74.23980),
  ('nashik', 'नाशिक', 'Nashik', 19.99750, 73.78980),
  ('palghar', 'पालघर', 'Palghar', 19.69670, 72.76990),
  ('parbhani', 'परभणी', 'Parbhani', 19.26860, 76.77080),
  ('pune', 'पुणे', 'Pune', 18.52040, 73.85670),
  ('raigad', 'रायगड', 'Raigad', 18.64140, 72.87220),
  ('ratnagiri', 'रत्नागिरी', 'Ratnagiri', 16.99020, 73.31200),
  ('sangli', 'सांगली', 'Sangli', 16.85240, 74.58150),
  ('satara', 'सातारा', 'Satara', 17.68050, 74.01830),
  ('sindhudurg', 'सिंधुदुर्ग', 'Sindhudurg', 16.11720, 73.69110),
  ('solapur', 'सोलापूर', 'Solapur', 17.65990, 75.90640),
  ('thane', 'ठाणे', 'Thane', 19.21830, 72.97810),
  ('wardha', 'वर्धा', 'Wardha', 20.74530, 78.60220),
  ('washim', 'वाशिम', 'Washim', 20.11100, 77.13300),
  ('yavatmal', 'यवतमाळ', 'Yavatmal', 20.38880, 78.12040);

-- ====================================================================
-- DISTRICT MANAGER ROLE
-- A district manager runs the events of exactly one district and has no
-- access to the website CMS.
-- ====================================================================

ALTER TABLE admin_users DROP CONSTRAINT admin_users_role_check;
ALTER TABLE admin_users ADD CONSTRAINT admin_users_role_check
  CHECK (role IN ('superadmin', 'admin', 'editor', 'district_manager'));
ALTER TABLE admin_users ADD COLUMN district_id INTEGER REFERENCES districts(id) ON DELETE RESTRICT;
ALTER TABLE admin_users ADD CONSTRAINT admin_users_dm_district
  CHECK (role <> 'district_manager' OR district_id IS NOT NULL);

-- ====================================================================
-- EVENTS AND STALL INVENTORY
-- ====================================================================

CREATE TABLE events (
  id                 SERIAL PRIMARY KEY,
  district_id        INTEGER NOT NULL REFERENCES districts(id) ON DELETE RESTRICT,
  title_mr           TEXT NOT NULL,
  title_en           TEXT NOT NULL DEFAULT '',
  description_mr     TEXT NOT NULL DEFAULT '',
  description_en     TEXT NOT NULL DEFAULT '',
  venue_mr           TEXT NOT NULL DEFAULT '',
  venue_en           TEXT NOT NULL DEFAULT '',
  start_date         DATE NOT NULL,
  end_date           DATE NOT NULL,
  cover_media_id     INTEGER REFERENCES media_assets(id) ON DELETE SET NULL,
  status             TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'cancelled')),
  registration_open  BOOLEAN NOT NULL DEFAULT TRUE,
  created_by         INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  updated_by         INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  deleted_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (end_date >= start_date)
);

CREATE INDEX events_district ON events (district_id) WHERE deleted_at IS NULL;
CREATE INDEX events_public ON events (start_date) WHERE deleted_at IS NULL AND status = 'published';

-- One row per event and quota. `available` is decremented atomically when a
-- registration takes a slot (UPDATE … WHERE available > 0), so concurrent
-- submissions can never oversell.
CREATE TABLE event_stall_quotas (
  event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  quota_type  TEXT NOT NULL CHECK (quota_type IN ('general', 'ews', 'sponsored')),
  total       INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),
  available   INTEGER NOT NULL DEFAULT 0 CHECK (available >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, quota_type),
  CHECK (available <= total)
);

-- ====================================================================
-- OTP VERIFICATION (contact number of an applicant)
-- ====================================================================

CREATE TABLE otp_verifications (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  phone        TEXT NOT NULL,
  code_hash    TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  expires_at   TIMESTAMPTZ NOT NULL,
  verified_at  TIMESTAMPTZ,
  consumed_at  TIMESTAMPTZ,
  ip_address   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX otp_verifications_phone ON otp_verifications (phone, created_at DESC);

-- ====================================================================
-- VENDOR REGISTRATIONS (stall applications)
-- Aadhaar is stored only encrypted (AES-256-GCM) plus its last four digits
-- for masked display and a keyed hash for duplicate detection.
-- ====================================================================

CREATE TABLE vendor_registrations (
  id                  SERIAL PRIMARY KEY,
  reference_no        TEXT NOT NULL UNIQUE,
  event_id            INTEGER NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  quota_type          TEXT NOT NULL CHECK (quota_type IN ('general', 'ews', 'sponsored')),
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'approved', 'rejected', 'waitlisted', 'cancelled')),
  name                TEXT NOT NULL,
  business_name       TEXT NOT NULL,
  nature_of_business  TEXT NOT NULL,
  category_id         INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  category_label      TEXT NOT NULL DEFAULT '',   -- label at submission time
  aadhaar_cipher      TEXT NOT NULL,
  aadhaar_last4       CHAR(4) NOT NULL,
  aadhaar_hash        TEXT NOT NULL,
  udyam_number        TEXT NOT NULL,
  udyam_verified      BOOLEAN NOT NULL DEFAULT FALSE,
  caste_category      TEXT NOT NULL,
  phone               TEXT NOT NULL,
  phone_verified_at   TIMESTAMPTZ,
  email               TEXT NOT NULL DEFAULT '',
  extra               JSONB NOT NULL DEFAULT '{}'::JSONB,  -- answers to form-builder fields
  language            TEXT NOT NULL DEFAULT 'mr' CHECK (language IN ('mr', 'en')),
  source              TEXT NOT NULL DEFAULT 'public' CHECK (source IN ('public', 'manager')),
  dm_notes            TEXT NOT NULL DEFAULT '',
  reviewed_by         INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  reviewed_at         TIMESTAMPTZ,
  ip_address          TEXT,
  user_agent          TEXT,
  deleted_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One open application per Aadhaar per event; a rejected or cancelled
-- applicant may apply again.
CREATE UNIQUE INDEX vendor_registrations_one_per_event
  ON vendor_registrations (event_id, aadhaar_hash)
  WHERE deleted_at IS NULL AND status NOT IN ('rejected', 'cancelled');
CREATE INDEX vendor_registrations_event ON vendor_registrations (event_id, status) WHERE deleted_at IS NULL;
CREATE INDEX vendor_registrations_waitlist ON vendor_registrations (event_id, quota_type, created_at)
  WHERE deleted_at IS NULL AND status = 'waitlisted';

-- ====================================================================
-- SPONSORS (district managers propose; a super admin approves)
-- district_id NULL = a statewide sponsor added by a super admin.
-- ====================================================================

CREATE TABLE sponsors (
  id              SERIAL PRIMARY KEY,
  district_id     INTEGER REFERENCES districts(id) ON DELETE RESTRICT,
  event_id        INTEGER REFERENCES events(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  tier            TEXT NOT NULL DEFAULT 'partner' CHECK (tier IN ('title', 'gold', 'silver', 'partner')),
  logo_media_id   INTEGER REFERENCES media_assets(id) ON DELETE SET NULL,
  website         TEXT NOT NULL DEFAULT '',
  description     TEXT NOT NULL DEFAULT '',
  contact_name    TEXT NOT NULL DEFAULT '',
  contact_phone   TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'approved', 'rejected')),
  review_note     TEXT NOT NULL DEFAULT '',
  requested_by    INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  requested_at    TIMESTAMPTZ,
  reviewed_by     INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  reviewed_at     TIMESTAMPTZ,
  display_order   INTEGER NOT NULL DEFAULT 0,
  created_by      INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  updated_by      INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  deleted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX sponsors_queue ON sponsors (requested_at) WHERE deleted_at IS NULL AND status = 'pending';
CREATE INDEX sponsors_public ON sponsors (display_order) WHERE deleted_at IS NULL AND status = 'approved';

-- ====================================================================
-- EVENT MEDIA (district manager media CMS: event galleries)
-- ====================================================================

CREATE TABLE event_media (
  id             SERIAL PRIMARY KEY,
  event_id       INTEGER NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  media_id       INTEGER NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
  caption        TEXT NOT NULL DEFAULT '',
  display_order  INTEGER NOT NULL DEFAULT 0,
  created_by     INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  deleted_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX event_media_event ON event_media (event_id, display_order) WHERE deleted_at IS NULL;

-- ====================================================================
-- DYNAMIC FORMS (super admin form builder)
-- `fields` is an array of { key, label_mr, label_en, type, required, options, max }
-- appended to the fixed registration fields.
-- ====================================================================

CREATE TABLE form_definitions (
  key         TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  fields      JSONB NOT NULL DEFAULT '[]'::JSONB,
  updated_by  INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO form_definitions (key, title) VALUES ('vendor_registration', 'Stall registration form');

-- ====================================================================
-- SUCCESS STORIES (content collection; two can be featured as banners)
-- ====================================================================

CREATE TABLE success_stories (
  id             SERIAL PRIMARY KEY,
  title_mr       TEXT NOT NULL,
  title_en       TEXT NOT NULL DEFAULT '',
  story_mr       TEXT NOT NULL DEFAULT '',
  story_en       TEXT NOT NULL DEFAULT '',
  person_mr      TEXT NOT NULL DEFAULT '',
  person_en      TEXT NOT NULL DEFAULT '',
  place_mr       TEXT NOT NULL DEFAULT '',
  place_en       TEXT NOT NULL DEFAULT '',
  image          JSONB NOT NULL DEFAULT '{"media_id": null, "url": ""}'::JSONB,
  is_featured    BOOLEAN NOT NULL DEFAULT FALSE,
  display_order  INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'draft')),
  created_by     INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  updated_by     INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  deleted_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX success_stories_public ON success_stories (display_order) WHERE deleted_at IS NULL AND status = 'published';
