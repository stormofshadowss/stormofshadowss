-- Launch controls: a group order can be marked as a TEST order (deletable with everything on it, until launch), and the site can be switched to LIVE for good.
ALTER TABLE group_orders ADD COLUMN is_test TINYINT(1) NOT NULL DEFAULT 0;
CREATE TABLE launch_state (
  id          TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  launched_at DATETIME(3) NULL,
  launched_by BIGINT UNSIGNED NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO launch_state (id, launched_at) VALUES (1, NULL);
