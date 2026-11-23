-- A LIMIT ON ONE OPTION: e.g. washi tape, Green = 3 available, Red = 2. NULL = no number of its own (the item's own limit rule applies, as before).
-- For member items ('independent') and size items. The whole-item purchase limit, if there is one, still caps the total.
ALTER TABLE item_members ADD COLUMN qty_limit INT UNSIGNED NULL;
ALTER TABLE item_variants ADD COLUMN qty_limit INT UNSIGNED NULL;
