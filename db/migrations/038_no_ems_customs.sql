-- ITEMS THAT DON'T CARRY EMS OR CUSTOMS. A standing tick on an item ("No EMS" / "No customs") applies in every box it is put in — e.g. the free bonus cards from purchase benefits. When a box is built the GOM can still change it for
-- that box, and what was used is remembered on the box's item (box_items.ems_excluded / customs_excluded) so a customs figure added later is split the same way. An excluded item's share is spread across the others (the totals are
-- always fully charged).
ALTER TABLE items ADD COLUMN no_ems TINYINT(1) NOT NULL DEFAULT 0, ADD COLUMN no_customs TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE box_items ADD COLUMN ems_excluded TINYINT(1) NOT NULL DEFAULT 0, ADD COLUMN customs_excluded TINYINT(1) NOT NULL DEFAULT 0;
-- the free bonus items purchase benefits already made carry neither
UPDATE items SET no_ems = 1, no_customs = 1 WHERE id IN (SELECT bonus_item_id FROM benefit_offers);
