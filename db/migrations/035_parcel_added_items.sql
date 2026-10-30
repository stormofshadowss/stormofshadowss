-- ADDING ITEMS TO A SHIPPING REQUEST that hasn't been packed yet: each item remembers when it was added after the request was made, and a parcel is flagged for the GOM when items were added while postage / packaging
-- fees were already set (the same totals are re-shared across all the items, so the GOM should check them). Saving the fees again, or pressing "Postage is fine", clears the flag.
ALTER TABLE parcel_items ADD COLUMN added_at DATETIME(3) NULL;
ALTER TABLE parcels ADD COLUMN fees_check_needed TINYINT(1) NOT NULL DEFAULT 0;
