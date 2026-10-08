-- When the GOM splits the cost of an unclaimed part of a secured set across the people in it, each claim takes on a share.
-- The share is added to the claim's item cost; this column remembers how much of that cost is such a share, so the joiner
-- can be told what the extra charge is for ("includes £2.67 for an unclaimed part").
ALTER TABLE claims ADD COLUMN split_share DECIMAL(10,2) NOT NULL DEFAULT 0;
