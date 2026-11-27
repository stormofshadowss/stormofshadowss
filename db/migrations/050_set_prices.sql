-- PRICE PER SET: a set is bought at one price, so every part in it costs the same, even if the item's price changes later (a proxy deal like "£10 a set up to 8 sets, then £15").
-- part_price is the price of each part of THIS set; NULL = it follows the item's price. (A part with its OWN price — a size or member price — still costs that.)
ALTER TABLE item_sets ADD COLUMN part_price DECIMAL(10,2) NULL;

-- Sets that already exist: if everyone in a set is paying the same price and it isn't the item's current price, the set remembers it — so a set you fixed by hand at £10 stays £10.
-- Only people whose part has no price of its own count, raffle wins (cost 0) and anything still TBC are ignored, and a share of an open part (split_share) is taken off. If the people in a set disagree, it is left alone.
UPDATE item_sets s
  JOIN items i ON i.id = s.item_id
  JOIN (SELECT c.set_id, MIN(cc.cost - c.split_share) AS lo, MAX(cc.cost - c.split_share) AS hi
          FROM claims c
          JOIN claim_costs cc ON cc.claim_id = c.id AND cc.category = 'initials'
          LEFT JOIN item_members im ON im.item_id = c.item_id AND im.name = c.member_name
         WHERE c.set_id IS NOT NULL AND c.status <> 'cancelled' AND c.price_tbc = 0 AND im.price IS NULL AND cc.cost - c.split_share > 0
         GROUP BY c.set_id) x ON x.set_id = s.id
   SET s.part_price = x.lo
 WHERE i.price_tbc = 0 AND x.lo = x.hi AND ABS(x.lo - i.price) > 0.004;
