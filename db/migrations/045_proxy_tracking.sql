-- "NOT VIA A PROXY": a group order, or one item, that is ordered directly or already on hand. It never appears in "Log a proxy payment".
ALTER TABLE group_orders ADD COLUMN no_proxy BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE items ADD COLUMN no_proxy BOOLEAN NOT NULL DEFAULT FALSE;
-- When a proxy payment was marked paid — the "Ordered from" history counts the days since then to say who to chase.
ALTER TABLE proxy_payments ADD COLUMN paid_at DATETIME(3) NULL;
UPDATE proxy_payments SET paid_at = created_at WHERE is_paid = 1;
