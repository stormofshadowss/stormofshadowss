-- An item can close for claims before the rest of its group order: on a date of its own, or when the GOM closes it by hand.
-- (close_date: claims stop after that day, UK time. closed_by_hand: closed now, until the GOM reopens it.)
ALTER TABLE items ADD COLUMN close_date DATE NULL, ADD COLUMN closed_by_hand TINYINT(1) NOT NULL DEFAULT 0;
