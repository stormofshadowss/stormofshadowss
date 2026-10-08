-- A proxy payment for an ordinary item covers the claims that existed when it was logged. Remember HOW MANY, so claims that arrive
-- afterwards show up as something new to pay for (instead of the item being considered paid for once and for all).
ALTER TABLE proxy_payment_items ADD COLUMN claim_count INT UNSIGNED NULL;

-- payments logged before this change covered every confirmed claim the item had at the time we're migrating
UPDATE proxy_payment_items ppi SET claim_count =
  (SELECT COUNT(*) FROM claims c WHERE c.item_id = ppi.item_id AND c.status = 'confirmed' AND c.set_id IS NULL)
 WHERE ppi.set_id IS NULL;
