-- One person, several handles: they can pay for all of them in ONE payment (stored as one row per handle, tied together by batch_key so the GOM verifies them as one),
-- and ship items from all of them in ONE parcel (their other handles join it automatically — how = 'own').
ALTER TABLE payments ADD COLUMN batch_key VARCHAR(40) NULL, ADD KEY ix_payments_batch (batch_key);
ALTER TABLE parcel_companions MODIFY how ENUM('joiner','gom','own') NOT NULL;
