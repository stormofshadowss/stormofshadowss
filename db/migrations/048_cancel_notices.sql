-- OPT-IN EMAIL KINDS: a few kinds of email are OFF unless the person asks for them. notify_optin = the comma list of those kinds this person HAS switched on (the usual notify_off lists the kinds switched OFF).
ALTER TABLE accounts ADD COLUMN notify_optin VARCHAR(255) NOT NULL DEFAULT '';

-- CANCELLED ORDERS / ITEMS: when the GOM cancels a whole group order or one item ("could not go ahead"), each person who had a claim on it gets a notice at the top of My orders for 30 days (or until they say "Got it").
-- One row per cancelled claim. refunded / forfeited are NULL when they aren't known (notices made from older cancellations below).
CREATE TABLE cancel_notices (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  joiner_id    BIGINT UNSIGNED NOT NULL,
  claim_id     BIGINT UNSIGNED NOT NULL,
  kind         ENUM('order', 'item') NOT NULL,
  order_id     BIGINT UNSIGNED NULL,
  order_title  VARCHAR(160) NOT NULL,
  item_id      BIGINT UNSIGNED NULL,
  item_title   VARCHAR(160) NOT NULL,
  label        VARCHAR(255) NOT NULL,
  refunded     DECIMAL(10,2) NULL,
  forfeited    DECIMAL(10,2) NULL,
  cancelled_at DATETIME(3) NOT NULL,
  dismissed_at DATETIME(3) NULL,
  UNIQUE KEY uq_cancel_notices_claim (claim_id),
  KEY ix_cancel_notices_joiner (joiner_id, dismissed_at, cancelled_at),
  CONSTRAINT fk_cancel_notices_joiner FOREIGN KEY (joiner_id) REFERENCES joiners (id) ON DELETE CASCADE,
  CONSTRAINT fk_cancel_notices_claim FOREIGN KEY (claim_id) REFERENCES claims (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Cancellations from the last 30 days, so people affected just before this update see them too. Approximate: a claim counts when it was cancelled within a minute of its item being cancelled.
INSERT INTO cancel_notices (joiner_id, claim_id, kind, order_id, order_title, item_id, item_title, label, refunded, forfeited, cancelled_at)
SELECT c.joiner_id, c.id, IF(go.cancelled_at IS NOT NULL AND ABS(TIMESTAMPDIFF(SECOND, go.cancelled_at, i.cancelled_at)) <= 5, 'order', 'item'), go.id, go.title, i.id, i.title, c.label, NULL, NULL, i.cancelled_at
  FROM claims c JOIN items i ON i.id = c.item_id JOIN group_orders go ON go.id = i.order_id
 WHERE c.status = 'cancelled' AND i.cancelled_at IS NOT NULL AND i.cancelled_at >= NOW(3) - INTERVAL 30 DAY AND ABS(TIMESTAMPDIFF(SECOND, c.updated_at, i.cancelled_at)) <= 60;
