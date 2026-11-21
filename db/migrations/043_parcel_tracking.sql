-- TRACKING NUMBER for a parcel posted OUT to a joiner (one per parcel). Typed by the GOM when she marks it shipped, or added / fixed afterwards. Joiners see it once the parcel is shipped; it is not emailed.
ALTER TABLE parcels ADD COLUMN tracking_no VARCHAR(40) NULL AFTER method;
