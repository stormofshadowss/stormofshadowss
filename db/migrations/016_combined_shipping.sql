-- Combined shipping: two friends' items go in ONE parcel to ONE address. The parcel stays the recipient's (parcels.joiner_id); the friend is its "companion".
-- Their items sit in the same parcel (parcel_items), but their own bias / Lomo name / notes are kept here, and so is whether they have agreed.
CREATE TABLE parcel_companions (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  parcel_id       BIGINT UNSIGNED NOT NULL,
  joiner_id       BIGINT UNSIGNED NOT NULL,
  status          ENUM('invited','accepted','declined') NOT NULL DEFAULT 'invited',
  how             ENUM('joiner','gom') NOT NULL,                    -- the recipient invited them, or the GOM combined two parcels
  bias            VARCHAR(80) NULL,
  lomo_name       VARCHAR(80) NULL,
  lomo_source     ENUM('delivery','custom') NULL,
  notes           TEXT NULL,
  lomo_checked_at DATETIME(3) NULL,
  bias_checked_at DATETIME(3) NULL,
  created_by      BIGINT UNSIGNED NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  responded_at    DATETIME(3) NULL,
  UNIQUE KEY uq_companion_parcel (parcel_id),                        -- two people per parcel
  KEY ix_companion_joiner (joiner_id, status),
  CONSTRAINT fk_comp_parcel FOREIGN KEY (parcel_id) REFERENCES parcels(id) ON DELETE CASCADE,
  CONSTRAINT fk_comp_joiner FOREIGN KEY (joiner_id) REFERENCES joiners(id),
  CONSTRAINT fk_comp_by     FOREIGN KEY (created_by) REFERENCES accounts(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
