-- A group order or a single item the GOM has cancelled because it can't be fulfilled (e.g. a photocard set sold out).
-- Cancelled orders and items disappear from the shop; their claims were cancelled and anything paid went back to the joiners as credit.
ALTER TABLE group_orders ADD COLUMN cancelled_at DATETIME(3) NULL;
ALTER TABLE items        ADD COLUMN cancelled_at DATETIME(3) NULL;
