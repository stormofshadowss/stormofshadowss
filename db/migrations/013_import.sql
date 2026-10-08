-- Importing from Notion. A batch is one upload and what came of it; its records remember every row it created, so the whole import can be undone
-- exactly, and so the same spreadsheet row can never be imported twice (source_key is unique per kind).
CREATE TABLE import_batches (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  source      VARCHAR(20)  NOT NULL DEFAULT 'notion',
  filename    VARCHAR(255) NULL,
  status      ENUM('draft','imported','undone') NOT NULL DEFAULT 'draft',
  row_count   INT UNSIGNED NOT NULL DEFAULT 0,
  payload     LONGTEXT NULL,                 -- the parsed spreadsheet rows while it's a draft; cleared once imported or undone
  mapping     LONGTEXT NULL,                 -- the GOM's decisions (who is who, which artist, what each status means)
  summary     LONGTEXT NULL,                 -- what the import did
  created_by  BIGINT UNSIGNED NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  imported_at DATETIME(3) NULL,
  undone_at   DATETIME(3) NULL,
  CONSTRAINT fk_import_by FOREIGN KEY (created_by) REFERENCES accounts(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE import_records (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  batch_id   BIGINT UNSIGNED NOT NULL,
  kind       ENUM('group','order','item','joiner','claim','payment') NOT NULL,
  entity_id  BIGINT UNSIGNED NOT NULL,
  source_key CHAR(40) NULL,
  UNIQUE KEY uq_import_source (kind, source_key),
  KEY ix_import_batch (batch_id, kind),
  CONSTRAINT fk_import_batch FOREIGN KEY (batch_id) REFERENCES import_batches(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
