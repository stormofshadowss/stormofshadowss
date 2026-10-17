-- An item can have a TOTAL purchase limit (a store limit, a bulky item): at most N claims across everyone, first come first served.
-- limit_scope says what N counts: 'item' = the whole item together, 'option' = each version / member / size on its own.
ALTER TABLE items ADD COLUMN purchase_limit INT UNSIGNED NULL, ADD COLUMN limit_scope ENUM('item','option') NOT NULL DEFAULT 'item';
