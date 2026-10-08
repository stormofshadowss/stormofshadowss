-- Linking an email to a handle without waiting for the GOM.
--
-- When someone claims as a brand-new handle, their browser is given a private "I made this claim" cookie.
-- Only a hash of it is stored here. Adding an email FROM THAT BROWSER links the handle straight away.
-- Anyone else asking to link that handle falls back to the GOM's approval (the rare case).
CREATE TABLE handle_proofs (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  joiner_id   BIGINT UNSIGNED NOT NULL,
  device_hash CHAR(64) NOT NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at  DATETIME(3) NOT NULL,
  UNIQUE KEY uq_handle_proofs (joiner_id, device_hash),
  CONSTRAINT fk_proofs_joiner FOREIGN KEY (joiner_id) REFERENCES joiners(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A sign-in link can carry "and link this handle" (decided when the link is requested, from the claiming browser,
-- so it still works when the email is opened on a different device).
ALTER TABLE login_tokens ADD COLUMN link_joiner_id BIGINT UNSIGNED NULL;

-- How and when each handle got its email, for the GOM's review list; plus the GOM's own "I've checked this person".
ALTER TABLE joiners
  ADD COLUMN linked_at   DATETIME(3) NULL,
  ADD COLUMN linked_via  ENUM('self_new','claim_device','approved') NULL,
  ADD COLUMN verified_at DATETIME(3) NULL;
