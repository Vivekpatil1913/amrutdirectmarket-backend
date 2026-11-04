-- Role-based moderation: a divisional manager role scoped to a revenue
-- division, success stories moderated and linked to completed events, and an
-- audit trail that records who acted, in what role and from where. Additive:
-- no table or column is dropped.

-- ====================================================================
-- DIVISIONS: the six revenue divisions of Maharashtra
-- ====================================================================

ALTER TABLE districts ADD COLUMN IF NOT EXISTS division TEXT;

UPDATE districts d SET division = m.division
  FROM (VALUES
    ('konkan', ARRAY['mumbai-city', 'mumbai-suburban', 'thane', 'palghar', 'raigad', 'ratnagiri', 'sindhudurg']),
    ('pune', ARRAY['pune', 'satara', 'sangli', 'solapur', 'kolhapur']),
    ('nashik', ARRAY['nashik', 'dhule', 'nandurbar', 'jalgaon', 'ahilyanagar']),
    ('chh-sambhajinagar', ARRAY['chh-sambhajinagar', 'jalna', 'beed', 'parbhani', 'hingoli', 'nanded', 'latur', 'dharashiv']),
    ('amravati', ARRAY['amravati', 'akola', 'yavatmal', 'buldhana', 'washim']),
    ('nagpur', ARRAY['nagpur', 'wardha', 'bhandara', 'gondia', 'chandrapur', 'gadchiroli'])
  ) AS m(division, codes)
 WHERE d.code = ANY(m.codes);

CREATE INDEX IF NOT EXISTS districts_division ON districts (division) WHERE deleted_at IS NULL;

-- ====================================================================
-- DIVISIONAL MANAGER
-- ====================================================================

ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS division TEXT;

ALTER TABLE admin_users DROP CONSTRAINT admin_users_role_check;
ALTER TABLE admin_users ADD CONSTRAINT admin_users_role_check
  CHECK (role IN ('superadmin', 'admin', 'editor', 'district_manager', 'divisional_manager'));
ALTER TABLE admin_users ADD CONSTRAINT admin_users_division_required
  CHECK (role <> 'divisional_manager' OR division IS NOT NULL);

-- ====================================================================
-- EVENTS: `status` already means draft / published / cancelled, so the
-- moderation state stays in approval_status. This exposes it in the
-- PENDING_APPROVAL / APPROVED / REJECTED form. Event dates, district, the
-- participant count and the completion state already exist or are computed.
-- ====================================================================

ALTER TABLE events ADD COLUMN IF NOT EXISTS moderation_status TEXT
  GENERATED ALWAYS AS (
    CASE approval_status WHEN 'approved' THEN 'APPROVED' WHEN 'rejected' THEN 'REJECTED' ELSE 'PENDING_APPROVAL' END
  ) STORED;

-- ====================================================================
-- SUCCESS STORIES: moderated, and tied to a completed event
-- ====================================================================

ALTER TABLE success_stories
  ADD COLUMN IF NOT EXISTS event_id        INTEGER REFERENCES events(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS district_id     INTEGER REFERENCES districts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'pending'
                                           CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  ADD COLUMN IF NOT EXISTS review_note     TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS submitted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS reviewed_by     INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at     TIMESTAMPTZ;

ALTER TABLE success_stories ADD COLUMN IF NOT EXISTS moderation_status TEXT
  GENERATED ALWAYS AS (
    CASE approval_status WHEN 'approved' THEN 'APPROVED' WHEN 'rejected' THEN 'REJECTED' ELSE 'PENDING_APPROVAL' END
  ) STORED;

-- NOT VALID: applies to new and edited stories without rejecting old samples.
ALTER TABLE success_stories ADD CONSTRAINT success_stories_story_length
  CHECK (char_length(story_mr) <= 100 AND char_length(story_en) <= 100) NOT VALID;

CREATE INDEX IF NOT EXISTS success_stories_event ON success_stories (event_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS success_stories_queue ON success_stories (submitted_at)
  WHERE deleted_at IS NULL AND approval_status = 'pending';

-- Stories written on an event went through that event's approval.
INSERT INTO success_stories (title_mr, title_en, story_mr, story_en, event_id, district_id, approval_status, reviewed_at)
SELECT e.title_mr, e.title_en, e.story_mr, e.story_en, e.id, e.district_id, 'approved', NOW()
  FROM events e
 WHERE (e.story_mr <> '' OR e.story_en <> '') AND e.approval_status = 'approved' AND e.deleted_at IS NULL;

-- ====================================================================
-- AUDIT TRAIL
-- ====================================================================

ALTER TABLE activity_logs
  ADD COLUMN IF NOT EXISTS user_role  TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS ip_address TEXT NOT NULL DEFAULT '';
