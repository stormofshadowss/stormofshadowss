-- More than two people can share a parcel (the new unique key is per person, not per parcel), and its fees can be split by WEIGHT instead of equally.
-- fee_split NULL = automatic: by weight for worldwide ("WW …") postage, equally per person for UK postage. weight_g = what the GOM weighed (the recipient's items on
-- the parcel, each friend's on their companion row); when it's blank the weight is estimated from the items' own weights / sizes.
ALTER TABLE parcel_companions ADD UNIQUE KEY uq_companion_person (parcel_id, joiner_id);
ALTER TABLE parcel_companions DROP INDEX uq_companion_parcel;
ALTER TABLE parcel_companions ADD COLUMN weight_g INT UNSIGNED NULL;
ALTER TABLE parcels ADD COLUMN fee_split ENUM('equal','weight') NULL, ADD COLUMN weight_g INT UNSIGNED NULL;
