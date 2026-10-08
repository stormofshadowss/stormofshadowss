-- A second per-parcel fee: PACKAGING, set by the GOM alongside postage (Doms) before a parcel is marked packed.
-- It is a normal cost line (owed, payable, credited back if a parcel is cancelled) shared across the parcel's items.
ALTER TABLE claim_costs         MODIFY category ENUM('initials','ems','customs','doms','packaging') NOT NULL;
ALTER TABLE payment_allocations MODIFY category ENUM('initials','ems','customs','doms','packaging') NOT NULL;
ALTER TABLE credit_ledger       MODIFY category ENUM('initials','ems','customs','doms','packaging') NULL;
ALTER TABLE parcels      ADD COLUMN packaging_total DECIMAL(10,2) NULL AFTER doms_total;
ALTER TABLE parcel_items ADD COLUMN packaging_share DECIMAL(10,2) NOT NULL DEFAULT 0 AFTER doms_share;
-- every claim that already exists gets its (empty) packaging line, like new claims do
INSERT IGNORE INTO claim_costs (claim_id, category) SELECT id, 'packaging' FROM claims;
