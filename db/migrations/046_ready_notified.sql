-- "More of your items are ready — add them to your shipping request": each claim is considered ONCE, the moment it becomes ready to pack / on hand (whether or not an email goes out).
ALTER TABLE claims ADD COLUMN ready_notified_at DATETIME(3) NULL;
-- everything already ready (or beyond) counts as considered, so switching this on doesn't email anyone about items they already know about
UPDATE claims SET ready_notified_at = NOW(3) WHERE pipeline IN ('ready to pack / on hand', 'packed', 'shipped', 'completed');
