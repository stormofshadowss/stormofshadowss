-- A joiner can ask to cancel a confirmed item; the GOM approves (choosing how much of what they paid to keep as a cancellation fee) or declines.
-- open_flag is 1 only while a request is pending, so the unique key allows ONE pending request per claim and any number of finished ones.
CREATE TABLE cancel_requests (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  claim_id         BIGINT UNSIGNED NOT NULL,
  joiner_id        BIGINT UNSIGNED NOT NULL,
  status           ENUM('pending','approved','declined','withdrawn') NOT NULL DEFAULT 'pending',
  open_flag        TINYINT NULL DEFAULT 1,
  reason           VARCHAR(500) NULL,
  stage            VARCHAR(60) NULL,                 -- where the item was when they asked
  requested_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  decided_at       DATETIME(3) NULL,
  decided_by       BIGINT UNSIGNED NULL,
  decision_note    VARCHAR(500) NULL,
  paid_at_decision DECIMAL(10,2) NULL,
  kept             DECIMAL(10,2) NULL,               -- the cancellation fee the GOM kept
  refunded         DECIMAL(10,2) NULL,               -- what went back to them as credit
  UNIQUE KEY uq_cancel_open (claim_id, open_flag),
  KEY ix_cancel_status (status, requested_at),
  KEY ix_cancel_joiner (joiner_id, status),
  CONSTRAINT fk_cr_claim  FOREIGN KEY (claim_id)   REFERENCES claims(id) ON DELETE CASCADE,
  CONSTRAINT fk_cr_joiner FOREIGN KEY (joiner_id)  REFERENCES joiners(id),
  CONSTRAINT fk_cr_by     FOREIGN KEY (decided_by) REFERENCES accounts(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
