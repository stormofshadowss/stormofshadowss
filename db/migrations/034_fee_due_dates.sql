-- A FEE (EMS, customs, postage, packaging) gets its OWN due date, picked by the GOM when it is added — it used to inherit the item's original pay-by date, so a fee added weeks later showed as overdue at once.
-- NULL means "no due date": never overdue. The item cost (category 'initials') still follows the claim's pay-by date, so nothing changes there.
ALTER TABLE claim_costs ADD COLUMN due_date DATE NULL;
-- Fees already added get a fresh due date from the day this is applied, so nobody is suddenly "overdue" because of one.
UPDATE claim_costs SET due_date = DATE_ADD(CURDATE(), INTERVAL 14 DAY) WHERE category <> 'initials' AND cost > paid;
