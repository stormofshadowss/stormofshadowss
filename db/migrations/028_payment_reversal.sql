-- A payment can fail AFTER the GOM verified it (a bank transfer that bounces days later): it is then marked 'reversed' — what it paid off is owed again.
ALTER TABLE payments MODIFY status ENUM('pending','confirmed','rejected','reversed') NOT NULL DEFAULT 'pending',
  ADD COLUMN reversed_at DATETIME(3) NULL, ADD COLUMN reversed_by BIGINT UNSIGNED NULL, ADD COLUMN reverse_reason VARCHAR(255) NULL;
