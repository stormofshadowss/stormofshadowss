-- ITEM WEIGHT: what ONE of an item weighs, in grams (optional). It carries over to the Warehouse: a claim that has no weight of its own uses its item's, so the EMS split for a box (and the weight-based postage sharing) use it
-- without anyone typing it again. A weight typed on a single claim in the Warehouse still wins; clearing it falls back to the item's. Changing the item's weight later reaches every claim that is not in a box yet.
ALTER TABLE items ADD COLUMN weight_g INT UNSIGNED NULL AFTER size_bucket;
