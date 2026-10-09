-- Joiner settings: which kinds of email they want, saved shipping defaults, changing the sign-in email, and anonymised deleted accounts.
ALTER TABLE accounts ADD COLUMN notify_off VARCHAR(255) NOT NULL DEFAULT '';            -- comma list of email kinds switched OFF (empty = all on, when notify_email is on)
ALTER TABLE joiners  ADD COLUMN anonymised_at DATETIME(3) NULL;                         -- set when a deleted person's handle was replaced by "deleted-<id>"
CREATE TABLE joiner_defaults (
  joiner_id   BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  bias        VARCHAR(80) NULL,
  lomo_name   VARCHAR(80) NULL,
  updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_jd_joiner FOREIGN KEY (joiner_id) REFERENCES joiners(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- A sign-in link that, when used, CHANGES this account's email to the token's email (instead of signing in as it).
ALTER TABLE login_tokens ADD COLUMN change_account_id BIGINT UNSIGNED NULL,
  ADD CONSTRAINT fk_lt_change FOREIGN KEY (change_account_id) REFERENCES accounts(id) ON DELETE CASCADE;
