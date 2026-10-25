-- An item can be HIDDEN FROM JOINERS: it isn't shown on the public order page and can't be claimed by anyone but the GOM (who adds it for people — e.g. a free bonus photocard from a purchase benefit).
-- Claims already on it stay as they are, and a joiner who has one still sees it in their own orders.
ALTER TABLE items ADD COLUMN hidden_from_public TINYINT(1) NOT NULL DEFAULT 0;
