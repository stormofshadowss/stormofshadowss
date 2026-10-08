-- Email notifications: opt-in (off by default), per account. The log makes sure a one-off email (the overdue reminder) is only ever sent once per claim.
ALTER TABLE accounts ADD COLUMN notify_email TINYINT(1) NOT NULL DEFAULT 0;

CREATE TABLE notification_log (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  joiner_id  BIGINT UNSIGNED NOT NULL,
  kind       VARCHAR(40) NOT NULL,
  ref_id     BIGINT UNSIGNED NOT NULL,
  sent_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY ux_notification_once (kind, ref_id),
  CONSTRAINT fk_notification_joiner FOREIGN KEY (joiner_id) REFERENCES joiners(id) ON DELETE CASCADE
) ENGINE=InnoDB;
