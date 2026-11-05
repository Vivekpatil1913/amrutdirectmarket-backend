-- Navigation per PRD v3: section targets take their final anchor names, two
-- tabs are renamed, and "Participate" leads to the upcoming events now that
-- the "Taking a stall is simple" section is gone. That section's content
-- (page_sections 'participate', eligibility_groups, participation_steps) is
-- left in place but is no longer served or editable.

-- Order matters: the 'events' tab is renamed before 'participate' takes over
-- the upcoming-events target.
UPDATE nav_items
   SET section = 'success-stories', label_mr = 'बाजारातील यशोगाथा',
       label_en = 'Success Stories from the market', updated_at = NOW()
 WHERE section = 'events';
UPDATE nav_items
   SET section = 'events-by-district', label_mr = 'जिल्हानिहाय प्रदर्शने',
       label_en = 'Events by district', updated_at = NOW()
 WHERE section = 'map';
UPDATE nav_items SET section = 'upcoming-events', updated_at = NOW() WHERE section = 'participate';

UPDATE quick_links SET section = 'upcoming-events', updated_at = NOW() WHERE section IN ('events', 'participate');
UPDATE quick_links SET section = 'events-by-district', updated_at = NOW() WHERE section = 'map';
