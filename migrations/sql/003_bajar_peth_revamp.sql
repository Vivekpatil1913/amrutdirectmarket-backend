-- Bajar Peth revamp: events need super-admin approval before they are public,
-- carry the full "Create Event (Bajar Peth)" details, and the stall booking
-- form becomes fully form-builder managed (system + custom fields, file
-- uploads, multi-select product categories). Adds the visitor counter.

-- ====================================================================
-- EVENTS: creation details and the approval workflow
-- Existing events were published by a super admin-era flow, so they start
-- approved; new ones default to pending.
-- ====================================================================

ALTER TABLE events
  ADD COLUMN city_mr               TEXT NOT NULL DEFAULT '',
  ADD COLUMN city_en               TEXT NOT NULL DEFAULT '',
  ADD COLUMN event_time            TEXT NOT NULL DEFAULT '',
  ADD COLUMN venue_map_link        TEXT NOT NULL DEFAULT '',
  ADD COLUMN contact_phone         TEXT NOT NULL DEFAULT '',
  ADD COLUMN sponsor_name          TEXT NOT NULL DEFAULT '',
  ADD COLUMN sponsor_logo_media_id INTEGER REFERENCES media_assets(id) ON DELETE SET NULL,
  ADD COLUMN approval_status       TEXT NOT NULL DEFAULT 'approved'
                                   CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  ADD COLUMN review_note           TEXT NOT NULL DEFAULT '',
  ADD COLUMN submitted_at          TIMESTAMPTZ,
  ADD COLUMN reviewed_by           INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  ADD COLUMN reviewed_at           TIMESTAMPTZ;

ALTER TABLE events ALTER COLUMN approval_status SET DEFAULT 'pending';

DROP INDEX events_public;
CREATE INDEX events_public ON events (start_date)
  WHERE deleted_at IS NULL AND status = 'published' AND approval_status = 'approved';
CREATE INDEX events_approval_queue ON events (submitted_at)
  WHERE deleted_at IS NULL AND approval_status = 'pending';

-- ====================================================================
-- STALL BOOKINGS: multi-select product categories, caste name and
-- uploaded files (caste certificate, file-type custom questions).
-- Udyam and the mobile number become form-builder controlled, so they
-- may be empty. Files are stored outside the public uploads folder.
-- ====================================================================

ALTER TABLE vendor_registrations
  ADD COLUMN category_ids INTEGER[] NOT NULL DEFAULT '{}',
  ADD COLUMN caste_name   TEXT NOT NULL DEFAULT '',
  ADD COLUMN files        JSONB NOT NULL DEFAULT '{}'::JSONB;   -- { field_key: { filename, original_name, mime_type, size_bytes } }

ALTER TABLE vendor_registrations ALTER COLUMN udyam_number SET DEFAULT '';
ALTER TABLE vendor_registrations ALTER COLUMN phone SET DEFAULT '';

UPDATE vendor_registrations SET category_ids = ARRAY[category_id] WHERE category_id IS NOT NULL;

-- The public form no longer sends an OTP (see the form builder instead).
DROP TABLE otp_verifications;

-- ====================================================================
-- STALL BOOKING FORM: every field is now part of the definition.
-- "system" fields map to columns and cannot be deleted; the ones marked
-- locked are always mandatory. Existing custom questions are kept after them.
-- ====================================================================

UPDATE form_definitions
   SET title = 'Stall booking form',
       fields = '[
         {"key": "name", "type": "text", "system": true, "label_mr": "व्यक्तीचे नाव", "label_en": "Name of individual", "required": true, "enabled": true, "options": []},
         {"key": "business_name", "type": "text", "system": true, "label_mr": "व्यवसायाचे नाव", "label_en": "Name of business", "required": true, "enabled": true, "options": []},
         {"key": "nature_of_business", "type": "select", "system": true, "label_mr": "व्यवसायाचे स्वरूप", "label_en": "Nature of business", "required": true, "enabled": true, "options": [
           {"value": "manufacturer", "label_mr": "उत्पादक", "label_en": "Manufacturer"},
           {"value": "artisan", "label_mr": "कारागीर / हस्तकला", "label_en": "Artisan / handicrafts"},
           {"value": "farmer", "label_mr": "शेतकरी / शेतकरी उत्पादक कंपनी", "label_en": "Farmer / FPO"},
           {"value": "shg", "label_mr": "स्वयं-सहायता गट", "label_en": "Self-help group"},
           {"value": "food_processing", "label_mr": "अन्न प्रक्रिया", "label_en": "Food processing"},
           {"value": "retailer", "label_mr": "किरकोळ विक्रेता", "label_en": "Retailer"},
           {"value": "wholesaler", "label_mr": "घाऊक विक्रेता", "label_en": "Wholesaler"},
           {"value": "service", "label_mr": "सेवा", "label_en": "Service provider"},
           {"value": "other", "label_mr": "इतर", "label_en": "Other"}
         ]},
         {"key": "product_categories", "type": "checkbox", "system": true, "label_mr": "उत्पादन श्रेणी", "label_en": "Product category", "required": true, "enabled": true, "options": []},
         {"key": "aadhaar", "type": "number", "system": true, "label_mr": "आधार क्रमांक", "label_en": "Aadhaar number", "required": true, "enabled": true, "options": []},
         {"key": "caste_category", "type": "select", "system": true, "label_mr": "जात प्रवर्ग", "label_en": "Caste category", "required": true, "enabled": true, "options": []},
         {"key": "caste_name", "type": "text", "system": true, "label_mr": "जातीचे नाव", "label_en": "Caste name", "required": true, "enabled": true, "options": []},
         {"key": "caste_certificate", "type": "file", "system": true, "label_mr": "जात प्रमाणपत्र", "label_en": "Caste certificate", "required": true, "enabled": true, "options": []},
         {"key": "phone", "type": "phone", "system": true, "label_mr": "मोबाईल क्रमांक", "label_en": "Mobile number", "required": true, "enabled": true, "options": []},
         {"key": "email", "type": "email", "system": true, "label_mr": "ईमेल", "label_en": "Email", "required": false, "enabled": false, "options": []},
         {"key": "udyam_number", "type": "text", "system": true, "label_mr": "उद्यम नोंदणी क्रमांक", "label_en": "Udyam Registration Number", "required": false, "enabled": false, "options": []}
       ]'::JSONB || fields
 WHERE key = 'vendor_registration';

-- ====================================================================
-- SITE COUNTERS (home-page statistics). Visitors start at a base of
-- one million, as the brief requires, and count up from there.
-- ====================================================================

CREATE TABLE site_counters (
  key         TEXT PRIMARY KEY,
  value       BIGINT NOT NULL DEFAULT 0 CHECK (value >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO site_counters (key, value) VALUES ('visitors', 1000000);

-- ====================================================================
-- HOME-PAGE SECTIONS: the introduction, "Why AMRUT Peth" and contact
-- sections are replaced (stories, upcoming events, district map), so
-- links that pointed at them now point at their replacements.
-- ====================================================================

UPDATE nav_items SET section = 'events', label_mr = 'आगामी प्रदर्शने', label_en = 'Upcoming events', updated_at = NOW()
 WHERE section = 'about';
UPDATE nav_items SET section = 'map', label_mr = 'जिल्हे', label_en = 'Districts', updated_at = NOW()
 WHERE section = 'register';
UPDATE quick_links SET section = 'events', updated_at = NOW() WHERE section = 'about';
UPDATE quick_links SET section = 'map', updated_at = NOW() WHERE section = 'register';

-- The first participation step pointed at the removed enquiry form; the
-- seeded wording (when unchanged) now points at "Book a Stall".
UPDATE participation_steps
   SET title_mr = 'स्टॉल बुक करा', title_en = 'Book a stall',
       desc_mr = 'आगामी प्रदर्शनावरील “स्टॉल बुक करा” वापरून आपली व व्यवसायाची माहिती द्या.',
       desc_en = 'Use “Book a Stall” on an upcoming event and give your and your business’s details.',
       updated_at = NOW()
 WHERE title_en = 'Register your interest'
   AND desc_en = 'Share your contact details and what you make using the enquiry form.';
