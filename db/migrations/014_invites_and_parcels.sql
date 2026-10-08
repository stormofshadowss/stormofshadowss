-- "Claim your orders" invite links: a one-time, expiring link the GOM sends someone (e.g. by Instagram DM) so their handle links to their account
-- when they sign in, without waiting for approval. Only a hash of the link is stored.
CREATE TABLE handle_invites (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  joiner_id  BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  used_at    DATETIME(3) NULL,
  used_by    BIGINT UNSIGNED NULL,
  revoked_at DATETIME(3) NULL,
  UNIQUE KEY uq_invite_hash (token_hash),
  KEY ix_invite_joiner (joiner_id, created_at),
  CONSTRAINT fk_invite_joiner FOREIGN KEY (joiner_id) REFERENCES joiners(id) ON DELETE CASCADE,
  CONSTRAINT fk_invite_by     FOREIGN KEY (created_by) REFERENCES accounts(id) ON DELETE SET NULL,
  CONSTRAINT fk_invite_used   FOREIGN KEY (used_by)    REFERENCES accounts(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE joiners       MODIFY linked_via ENUM('self_new','claim_device','approved','invite') NULL;
ALTER TABLE login_tokens  ADD COLUMN invite_id BIGINT UNSIGNED NULL;      -- set when a sign-in link was requested through an invite
-- imported "Shipping to you" claims get a shipped parcel per person (so they can press "It's arrived"); an import remembers those parcels too
ALTER TABLE import_records MODIFY kind ENUM('group','order','item','joiner','claim','payment','parcel') NOT NULL;
