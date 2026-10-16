-- On-hand (shop) items can belong to an artist group, so the Shop page can be filtered by artist like the home page. No group = shown under "Other".
ALTER TABLE leftover_items ADD COLUMN group_id BIGINT UNSIGNED NULL, ADD KEY ix_leftover_group (group_id),
  ADD CONSTRAINT fk_leftover_group FOREIGN KEY (group_id) REFERENCES artist_groups(id) ON DELETE SET NULL;
