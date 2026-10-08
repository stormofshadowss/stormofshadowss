-- Packing checklist: each item is ticked off as it goes in the box, and the GOM confirms the delivery address,
-- the Lomo name and the bias name before the parcel can be marked packed. Ticks are saved as you go, so a refresh
-- (or coming back later) never loses them.
ALTER TABLE parcel_items ADD COLUMN packed_at DATETIME(3) NULL;
ALTER TABLE parcels
  ADD COLUMN address_checked_at DATETIME(3) NULL,
  ADD COLUMN lomo_checked_at    DATETIME(3) NULL,
  ADD COLUMN bias_checked_at    DATETIME(3) NULL;
