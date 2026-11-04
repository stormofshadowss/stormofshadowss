-- SHOP ITEMS WITH OPTIONS: one shop listing the buyer picks from — a member (Han, Felix…), a size (L, M), a version (Album A, Album B). Each option has its OWN count in stock and, when it differs, its own price.
-- option_label is what the picker is called ("Member", "Size", "Version" or "Option"); NULL = an ordinary shop item (one count, nothing to choose), exactly as before. For an item with options leftover_items.qty is the SUM of
-- its options' counts (kept up to date by the server), so "how many are left" keeps working for the whole listing. A claim remembers which option it took.
ALTER TABLE leftover_items ADD COLUMN option_label VARCHAR(20) NULL;
CREATE TABLE leftover_options (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  leftover_item_id  BIGINT UNSIGNED NOT NULL,
  name              VARCHAR(80) NOT NULL,
  qty               INT UNSIGNED NOT NULL DEFAULT 1,
  price             DECIMAL(10,2) NULL,
  sort_order        INT NOT NULL DEFAULT 0,
  UNIQUE KEY uq_leftover_option (leftover_item_id, name),
  CONSTRAINT fk_leftover_option_item FOREIGN KEY (leftover_item_id) REFERENCES leftover_items(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
ALTER TABLE claims ADD COLUMN leftover_option_id BIGINT UNSIGNED NULL, ADD KEY ix_claims_leftover_option (leftover_option_id),
  ADD CONSTRAINT fk_claims_leftover_option FOREIGN KEY (leftover_option_id) REFERENCES leftover_options(id) ON DELETE SET NULL;
