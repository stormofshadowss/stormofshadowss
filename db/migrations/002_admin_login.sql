-- Admin (GOM) accounts sign in with a username and password. Joiners keep using emailed links.
-- An admin account can NOT use the emailed-link route, otherwise the password could be bypassed
-- by anyone who can read that inbox.
ALTER TABLE accounts
  ADD COLUMN is_admin      BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN username      VARCHAR(40) NULL,
  ADD COLUMN password_hash VARCHAR(255) NULL,            -- scrypt, salted. Never the password itself.
  ADD COLUMN failed_logins INT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN locked_until  DATETIME(3) NULL,             -- temporary lock after repeated wrong passwords
  ADD UNIQUE KEY uq_accounts_username (username);
