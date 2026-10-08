-- Shop (leftover) stock: items already on hand, claimed straight away. Each item says how many days people get to pay, and what size bucket it is
-- (used for storage and box weights). A claim remembers its own pay-by date, so it shows in Overdue once that passes.
ALTER TABLE leftover_items
  ADD COLUMN pay_days     TINYINT UNSIGNED NOT NULL DEFAULT 5,
  ADD COLUMN size_bucket  ENUM('XS','S','M','L','XL') NOT NULL DEFAULT 'M';
ALTER TABLE claims ADD COLUMN pay_by DATE NULL;
