-- OPTIONAL PASSWORDS FOR JOINERS (alongside the emailed sign-in link). accounts.password_hash is the column admins already use; a joiner's stays NULL until they choose to set one.
-- password_set_at: when. password_nudge_off: they pressed "No thanks" (or set one), so the "Want to skip the email next time?" card is not shown again.
ALTER TABLE accounts ADD COLUMN password_set_at DATETIME(3) NULL, ADD COLUMN password_nudge_off TINYINT(1) NOT NULL DEFAULT 0;
-- How a session began: 'link' (the emailed sign-in link) or 'password'. Changing or removing a password asks for the current one only in a session that began with the password
-- (someone who has just proved they own the email by a link can set a new one — that is how "I forgot my password" works).
ALTER TABLE sessions ADD COLUMN via VARCHAR(10) NOT NULL DEFAULT 'link';
