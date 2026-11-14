-- DELETING A SHOP LISTING. A listing nobody ever claimed is deleted for good (with its options and picture). A listing that has claim rows (even cancelled ones) can't be erased — the claims point at it —
-- so it is ARCHIVED: deleted_at is set (and it is switched off), it disappears from every list the GOM and the joiners see, and it is kept behind the scenes so those claims, payments and packing carry on.
ALTER TABLE leftover_items ADD COLUMN deleted_at DATETIME(3) NULL;
