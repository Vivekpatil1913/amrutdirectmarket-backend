-- Success stories now come from completed events: each event carries a short
-- story, and its cover is the photo. The success_stories table is no longer
-- served or editable; its rows are left in place.
ALTER TABLE events
  ADD COLUMN story_mr TEXT NOT NULL DEFAULT '' CHECK (char_length(story_mr) <= 100),
  ADD COLUMN story_en TEXT NOT NULL DEFAULT '' CHECK (char_length(story_en) <= 100);
